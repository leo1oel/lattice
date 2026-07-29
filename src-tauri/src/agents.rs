use crate::commands;
use crate::models::{
    AgentAttachmentDescriptor, AgentAttachmentMetadata, AgentCommand, AgentResult, AgentSettings,
    AgentStreamEvent, SubscriptionLoginEvent, SubscriptionStatus,
};
use crate::project;
use crate::skill_store;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::{ImageFormat, ImageReader, Limits};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::{BufRead, BufReader, Cursor, Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const AGENT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const SUBSCRIPTION_AUTH_ERROR_PREFIX: &str = "LATTICE_AUTH_SUBSCRIPTION:";
const API_KEY_AUTH_ERROR_PREFIX: &str = "LATTICE_AUTH_API_KEY:";
const AGENT_STOPPED_ERROR_PREFIX: &str = "LATTICE_AGENT_STOPPED:";
const MAX_ATTACHMENTS: usize = 8;
const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES: u64 = 64 * 1024 * 1024;
const ATTACHMENT_PREVIEW_MAX_DIMENSION: u32 = 512;
const MAX_PDF_PAGES: usize = 200;
const MAX_PDF_TEXT_CHARS: usize = 400_000;
const MAX_TOTAL_PDF_TEXT_CHARS: usize = 600_000;
#[cfg(not(test))]
const CANCEL_GRACE_PERIOD: Duration = Duration::from_secs(2);
#[cfg(test)]
const CANCEL_GRACE_PERIOD: Duration = Duration::from_millis(100);

#[derive(Clone)]
pub struct AgentRuntime {
    /// The copy inside the app bundle. Read-only and code-signed, so it is the
    /// floor rather than the thing that runs when a newer one is installed.
    pub executable: PathBuf,
    pub assets: PathBuf,
    pub config: PathBuf,
    active_runs: Arc<Mutex<HashMap<String, ActiveRun>>>,
}

#[derive(Clone)]
struct ActiveRun {
    stdin: Weak<Mutex<ChildStdin>>,
    cancellation_requested: Arc<AtomicBool>,
    process_lifecycle: Arc<ProcessLifecycle>,
    process_id: u32,
}

struct ProcessLifecycle {
    exited: Mutex<bool>,
    exit_notification: Condvar,
    termination_sent: AtomicBool,
}

impl ProcessLifecycle {
    fn new() -> Self {
        Self {
            exited: Mutex::new(false),
            exit_notification: Condvar::new(),
            termination_sent: AtomicBool::new(false),
        }
    }

    fn mark_exited(&self) {
        if let Ok(mut exited) = self.exited.lock() {
            *exited = true;
            self.exit_notification.notify_all();
        }
    }

    fn wait_for_exit(&self, timeout: Duration) -> bool {
        let Ok(exited) = self.exited.lock() else {
            return false;
        };
        let Ok((exited, _)) =
            self.exit_notification
                .wait_timeout_while(exited, timeout, |exited| !*exited)
        else {
            return false;
        };
        *exited
    }

    fn terminate_once(&self, process_id: u32) {
        if !self.termination_sent.swap(true, Ordering::SeqCst) {
            terminate_process_tree(process_id);
        }
    }
}

impl AgentRuntime {
    /// The executable to launch: an installed update when one is newer than
    /// the bundle, otherwise the bundle's own.
    pub fn active_executable(&self) -> PathBuf {
        match self.bundled_version() {
            Some(version) => {
                crate::omp_update::resolve_executable(&self.executable, &self.config, &version)
            }
            None => self.executable.clone(),
        }
    }

    /// The version shipped in the app bundle.
    pub fn bundled_version(&self) -> Option<String> {
        omp_bundled_version(self)
    }

    /// The version that will actually run.
    pub fn running_version(&self) -> Option<String> {
        let bundled = self.bundled_version()?;
        Some(crate::omp_update::current_version(&self.config, &bundled))
    }

    pub fn new(executable: PathBuf, assets: PathBuf, config: PathBuf) -> Self {
        Self {
            executable,
            assets,
            config,
            active_runs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn register_run(
        &self,
        session_id: &str,
        stdin: Weak<Mutex<ChildStdin>>,
        process_id: u32,
        process_lifecycle: Arc<ProcessLifecycle>,
    ) -> Result<ActiveRunRegistration, String> {
        let mut runs = self
            .active_runs
            .lock()
            .map_err(|_| "Agent run state is unavailable.".to_string())?;
        if runs
            .get(session_id)
            .is_some_and(|run| run.stdin.upgrade().is_some())
        {
            return Err("This conversation already has an agent running.".to_string());
        }
        let cancellation_requested = Arc::new(AtomicBool::new(false));
        runs.insert(
            session_id.to_string(),
            ActiveRun {
                stdin,
                cancellation_requested: Arc::clone(&cancellation_requested),
                process_lifecycle,
                process_id,
            },
        );
        Ok(ActiveRunRegistration {
            runtime: self.clone(),
            session_id: session_id.to_string(),
            cancellation_requested,
        })
    }

    pub fn abort_run(&self, session_id: &str) -> Result<bool, String> {
        let active = self
            .active_runs
            .lock()
            .map_err(|_| "Agent run state is unavailable.".to_string())?
            .get(session_id)
            .cloned();
        let Some(active) = active else {
            return Ok(false);
        };
        if active.cancellation_requested.swap(true, Ordering::SeqCst) {
            return Ok(true);
        }
        schedule_forced_stop(active.process_id, Arc::clone(&active.process_lifecycle));
        let Some(stdin) = active.stdin.upgrade() else {
            return Ok(true);
        };
        let _ = write_json_line(
            &stdin,
            &json!({ "id": "lattice-abort", "type": "abort" }),
            "Lattice agent",
        );
        Ok(true)
    }
}

struct ActiveRunRegistration {
    runtime: AgentRuntime,
    session_id: String,
    cancellation_requested: Arc<AtomicBool>,
}

impl ActiveRunRegistration {
    fn was_cancelled(&self) -> bool {
        self.cancellation_requested.load(Ordering::SeqCst)
    }

    fn result_or_cancelled<T>(&self, result: Result<T, String>) -> Result<T, String> {
        result.map_err(|error| {
            if self.was_cancelled() {
                agent_stopped_error()
            } else {
                error
            }
        })
    }
}

impl Drop for ActiveRunRegistration {
    fn drop(&mut self) {
        let Ok(mut runs) = self.runtime.active_runs.lock() else {
            return;
        };
        let is_current = runs.get(&self.session_id).is_some_and(|run| {
            Arc::ptr_eq(&run.cancellation_requested, &self.cancellation_requested)
        });
        if is_current {
            runs.remove(&self.session_id);
        }
    }
}

pub struct AgentRequest<'a> {
    pub settings: &'a AgentSettings,
    pub message: &'a str,
    pub attachments: &'a [AgentAttachmentDescriptor],
    pub active_file: Option<&'a str>,
    pub selection: Option<&'a str>,
    pub session_id: &'a str,
    pub session_title: &'a str,
    pub system_prompt: &'a str,
}

pub struct ForkedSession {
    pub session_id: String,
    pub source_timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OmpSessionRef {
    session_id: String,
    file_name: String,
}

struct OmpAuth {
    provider: &'static str,
    environment: Option<(&'static str, String)>,
}

struct OmpRunResult {
    summary: String,
    skills_used: Vec<String>,
}

#[derive(Debug)]
struct LoadedAttachments {
    text: String,
    images: Vec<Value>,
    metadata: Vec<AgentAttachmentMetadata>,
}

fn load_attachments(
    descriptors: &[AgentAttachmentDescriptor],
    include_previews: bool,
) -> Result<LoadedAttachments, String> {
    if descriptors.len() > MAX_ATTACHMENTS {
        return Err(format!(
            "Attach at most {MAX_ATTACHMENTS} files per message."
        ));
    }
    let mut total = 0_u64;
    let mut text = String::new();
    let mut images = Vec::new();
    let mut attachment_metadata = Vec::new();
    let mut total_pdf_text_chars = 0_usize;
    for descriptor in descriptors {
        let path = Path::new(&descriptor.path);
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&descriptor.name);
        let file = fs::File::open(path).map_err(|_| {
            format!(
                "Attachment '{}' no longer exists. Remove it and attach it again.",
                name
            )
        })?;
        let metadata = file
            .metadata()
            .map_err(|error| format!("Could not inspect attachment '{name}': {error}"))?;
        if !metadata.is_file() {
            return Err(format!("Attachment '{name}' is not a regular file."));
        }
        let mut bytes = Vec::with_capacity(
            usize::try_from(metadata.len().min(MAX_ATTACHMENT_BYTES) + 1).unwrap_or(0),
        );
        file.take(MAX_ATTACHMENT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("Could not read attachment '{name}': {error}"))?;
        if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
            return Err(format!(
                "Attachment '{}' exceeds the 20 MiB per-file limit.",
                name
            ));
        }
        total = total.saturating_add(bytes.len() as u64);
        if total > MAX_TOTAL_ATTACHMENT_BYTES {
            return Err(
                "Attachments exceed the 64 MiB total limit. Remove one or more files.".into(),
            );
        }
        let mime = image_mime(&bytes);
        if let Some(mime_type) = mime {
            images.push(
                json!({ "type": "image", "data": STANDARD.encode(&bytes), "mimeType": mime_type }),
            );
            attachment_metadata.push(AgentAttachmentMetadata {
                name: name.to_string(),
                kind: "image".into(),
                mime_type: Some(mime_type.into()),
                size: bytes.len() as u64,
                preview_url: include_previews.then(|| image_preview(&bytes)).flatten(),
            });
            continue;
        }
        if bytes.starts_with(b"%PDF-") {
            let content = extract_pdf_text(&bytes, name)?;
            total_pdf_text_chars = total_pdf_text_chars.saturating_add(content.chars().count());
            if total_pdf_text_chars > MAX_TOTAL_PDF_TEXT_CHARS {
                return Err(format!(
                    "PDF attachments exceed the {MAX_TOTAL_PDF_TEXT_CHARS}-character extracted-text limit. Attach fewer documents."
                ));
            }
            if content.trim().is_empty() {
                return Err(format!(
                    "PDF attachment '{name}' contains no extractable text. It may be scanned or image-only; use OCR first."
                ));
            }
            let escaped_name = html_escape::encode_double_quoted_attribute(name);
            text.push_str(&format!(
                "\n\n<file name=\"{escaped_name}\">\n{content}\n</file>"
            ));
            attachment_metadata.push(AgentAttachmentMetadata {
                name: name.to_string(),
                kind: "document".into(),
                mime_type: Some("application/pdf".into()),
                size: bytes.len() as u64,
                preview_url: None,
            });
            continue;
        }
        let content = std::str::from_utf8(&bytes).map_err(|_| unsupported_attachment(name))?;
        if content.contains('\0') {
            return Err(format!(
                "Attachment '{}' contains NUL bytes and is not valid text.",
                name
            ));
        }
        // Magic signatures win over a coincidentally UTF-8 prefix.
        if known_binary(&bytes) {
            return Err(unsupported_attachment(name));
        }
        let escaped_name = html_escape::encode_double_quoted_attribute(name);
        text.push_str(&format!(
            "\n\n<file name=\"{escaped_name}\">\n{content}\n</file>"
        ));
        attachment_metadata.push(AgentAttachmentMetadata {
            name: name.to_string(),
            kind: "text".into(),
            mime_type: Some("text/plain".into()),
            size: bytes.len() as u64,
            preview_url: None,
        });
    }
    Ok(LoadedAttachments {
        text,
        images,
        metadata: attachment_metadata,
    })
}

fn extract_pdf_text(bytes: &[u8], name: &str) -> Result<String, String> {
    catch_unwind(AssertUnwindSafe(|| {
        let document = lopdf::Document::load_mem(bytes)
            .map_err(|error| format!("Could not read PDF '{name}': {error}"))?;
        let page_count = document.get_pages().len();
        if page_count > MAX_PDF_PAGES {
            return Err(format!(
                "PDF attachment '{name}' has {page_count} pages; the limit is {MAX_PDF_PAGES}. Attach a smaller document."
            ));
        }
        drop(document);
        let content = pdf_extract::extract_text_from_mem(bytes)
            .map_err(|error| format!("Could not extract text from PDF '{name}': {error}"))?;
        let text_chars = content.chars().count();
        if text_chars > MAX_PDF_TEXT_CHARS {
            return Err(format!(
                "PDF attachment '{name}' extracts to {text_chars} characters; the limit is {MAX_PDF_TEXT_CHARS}. Attach a smaller document."
            ));
        }
        Ok(content)
    }))
    .map_err(|_| format!("Could not read PDF '{name}': the document is malformed."))?
}

pub fn inspect_attachments(
    descriptors: &[AgentAttachmentDescriptor],
) -> Result<Vec<AgentAttachmentMetadata>, String> {
    load_attachments(descriptors, true).map(|attachments| attachments.metadata)
}

fn image_preview(bytes: &[u8]) -> Option<String> {
    let format = image::guess_format(bytes).ok()?;
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().ok()?;
    let preview = image.thumbnail(
        ATTACHMENT_PREVIEW_MAX_DIMENSION,
        ATTACHMENT_PREVIEW_MAX_DIMENSION,
    );
    let mut encoded = Vec::new();
    JpegEncoder::new_with_quality(&mut encoded, 70)
        .encode_image(&preview)
        .ok()?;
    Some(format!(
        "data:image/jpeg;base64,{}",
        STANDARD.encode(encoded)
    ))
}

fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    let format = image::guess_format(bytes).ok()?;
    let mime = match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::Gif => "image/gif",
        ImageFormat::WebP => "image/webp",
        _ => return None,
    };
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader.decode().ok()?;
    (decoded.width() > 0 && decoded.height() > 0).then_some(mime)
}

fn known_binary(bytes: &[u8]) -> bool {
    let prefix = String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]).to_ascii_lowercase();
    let trimmed = prefix.trim_start_matches(['\u{feff}', ' ', '\t', '\r', '\n']);
    let svg =
        trimmed.starts_with("<svg") || (trimmed.starts_with("<?xml") && trimmed.contains("<svg"));
    svg || bytes.starts_with(b"%PDF-")
        || bytes.starts_with(b"PK\x03\x04")
        || bytes.starts_with(b"\x7fELF")
        || bytes.starts_with(b"MZ")
        || bytes.starts_with(b"\xca\xfe\xba\xbe")
}

fn unsupported_attachment(name: &str) -> String {
    format!("Attachment '{name}' is not a supported PDF, image, or UTF-8 text file. Convert documents/archives to PDF or plain text, or attach a PNG, JPEG, GIF, or WebP image.")
}

pub fn run(
    root: &Path,
    runtime: &AgentRuntime,
    request: AgentRequest<'_>,
    on_event: &dyn Fn(AgentStreamEvent),
) -> Result<AgentResult, String> {
    if request.message.trim().is_empty() && request.attachments.is_empty() {
        return Err("Write a message first.".to_string());
    }
    if request.settings.model.trim().is_empty()
        || request.settings.reasoning_effort.trim().is_empty()
    {
        return Err("Choose a model and reasoning effort.".to_string());
    }
    // Validate and bound every file before starting OMP. The opened handles are
    // read exactly once, so a path replacement cannot change what gets sent.
    let attachments = load_attachments(request.attachments, false)?;
    on_event(AgentStreamEvent::Attachments {
        attachments: attachments.metadata.clone(),
    });

    let before = project::snapshot_text_files(root)?;
    on_event(AgentStreamEvent::Status {
        message: "Starting agent…".to_string(),
    });
    let outcome = run_omp(root, runtime, &request, &attachments, on_event)
        .map_err(|error| rewrite_agent_auth_error(runtime, &request.settings.provider, &error));
    let transaction = project::record_agent_changes(
        root,
        &before,
        &format!("Agent: {}", compact_label(request.message)),
        request.session_id,
    )?;
    let changed_files = transaction
        .as_ref()
        .map(|record| {
            record
                .changes
                .iter()
                .map(|change| change.path.clone())
                .collect()
        })
        .unwrap_or_default();

    match outcome {
        Ok(outcome) => Ok(AgentResult {
            summary: outcome.summary,
            notice: None,
            changed_files,
            transaction_id: transaction.map(|record| record.id),
            skills_used: outcome.skills_used,
            attachments: attachments.metadata,
        }),
        Err(error) if error.starts_with(AGENT_STOPPED_ERROR_PREFIX) => {
            let notice = if transaction.is_some() {
                "Stopped. File changes made before cancellation were preserved in Project History."
            } else {
                "Stopped."
            };
            Ok(AgentResult {
                summary: notice.to_string(),
                notice: Some(notice.to_string()),
                changed_files,
                transaction_id: transaction.map(|record| record.id),
                skills_used: Vec::new(),
                attachments: attachments.metadata,
            })
        }
        Err(error) if transaction.is_some() => {
            let notice = format!(
                "The agent stopped before it could finish its response, but its file changes were preserved in Project History.\n\n{error}"
            );
            Ok(AgentResult {
                summary: notice.clone(),
                notice: Some(notice),
                changed_files,
                transaction_id: transaction.map(|record| record.id),
                skills_used: Vec::new(),
                attachments: attachments.metadata,
            })
        }
        Err(error) => Err(error),
    }
}

fn run_omp(
    root: &Path,
    runtime: &AgentRuntime,
    request: &AgentRequest<'_>,
    attachments: &LoadedAttachments,
    on_event: &dyn Fn(AgentStreamEvent),
) -> Result<OmpRunResult, String> {
    let command = omp_command(
        root,
        runtime,
        request.settings,
        request.session_id,
        request.session_title,
        request.system_prompt,
    )?;

    let mut process = JsonLineProcess::spawn(command, "Lattice agent")?;
    let run_registration = runtime.register_run(
        request.session_id,
        process.stdin_handle(),
        process.id(),
        process.lifecycle_handle(),
    )?;
    on_event(AgentStreamEvent::Cancellable { enabled: true });
    let state = run_registration.result_or_cancelled(process.request(
        "lattice-session-state",
        "get_state",
        json!({}),
    ))?;
    persist_session_from_state(root, request.session_id, &state)?;
    if !request.session_title.trim().is_empty() {
        run_registration.result_or_cancelled(process.request(
            "lattice-session-name",
            "set_session_name",
            json!({ "name": request.session_title.trim() }),
        ))?;
    }
    if run_registration.was_cancelled() {
        return Err(agent_stopped_error());
    }
    let message = if request.message.trim().is_empty() {
        "Please review the attached material."
    } else {
        request.message
    };
    let mut prompt = editor_prompt(message, request.active_file, request.selection);
    prompt.push_str(&attachments.text);
    let mut prompt_request = json!({
        "id": "lattice-prompt",
        "type": "prompt",
        "message": prompt
    });
    if !attachments.images.is_empty() {
        prompt_request["images"] = Value::Array(attachments.images.clone());
    }
    run_registration.result_or_cancelled(process.send(&prompt_request))?;

    on_event(AgentStreamEvent::Status {
        message: "Thinking…".to_string(),
    });
    let mut visible = String::new();
    let mut accepted = false;
    let mut completed = false;
    let mut failure = None;
    let mut skills_used = BTreeSet::new();
    loop {
        let Some(value) = run_registration.result_or_cancelled(process.next_value())? else {
            let (_, stderr) = run_registration.result_or_cancelled(process.finish(false))?;
            if run_registration.was_cancelled() {
                return Err(agent_stopped_error());
            }
            return Err(format!(
                "The agent stopped before completing the response.{}",
                stderr_suffix(&stderr)
            ));
        };
        if value.get("type").and_then(Value::as_str) == Some("response")
            && value.get("id").and_then(Value::as_str) == Some("lattice-prompt")
        {
            accepted = value
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            // A slash command (`/context`, `/compact`, …) is answered inline and
            // never starts a turn, so no `agent_end` is coming. OMP reports that
            // as `data.agentInvoked: false` on this very response; without this
            // the loop would wait out the full timeout.
            if value.pointer("/data/agentInvoked").and_then(Value::as_bool) == Some(false) {
                completed = true;
            }
            if !accepted {
                failure = Some(
                    value
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("The agent rejected the prompt.")
                        .to_string(),
                );
            }
        }
        match value.get("type").and_then(Value::as_str) {
            Some("message_update") => {
                let event = value.get("assistantMessageEvent").unwrap_or(&Value::Null);
                match event.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                            visible.push_str(delta);
                            on_event(AgentStreamEvent::Text {
                                text: visible.clone(),
                            });
                        }
                    }
                    Some("error") => {
                        failure = Some(
                            event
                                .get("error")
                                .and_then(Value::as_str)
                                .or_else(|| event.get("reason").and_then(Value::as_str))
                                .unwrap_or("The model stopped with an error.")
                                .to_string(),
                        );
                    }
                    _ => {}
                }
            }
            Some("message_end") if visible.trim().is_empty() => {
                if let Some(text) = assistant_text(value.get("message").unwrap_or(&Value::Null)) {
                    visible = text;
                    on_event(AgentStreamEvent::Text {
                        text: visible.clone(),
                    });
                }
            }
            Some("tool_execution_start") => {
                if let Some(skill) = tool_skill_name(&value) {
                    skills_used.insert(skill);
                }
                let detail = tool_status(&value);
                on_event(AgentStreamEvent::Status {
                    message: detail.clone(),
                });
                on_event(AgentStreamEvent::Tool {
                    name: tool_name(&value),
                    detail,
                    phase: "start".to_string(),
                });
            }
            Some("tool_execution_end") => {
                on_event(AgentStreamEvent::Status {
                    message: "Reviewing tool results…".to_string(),
                });
                on_event(AgentStreamEvent::Tool {
                    name: tool_name(&value),
                    detail: "done".to_string(),
                    phase: "end".to_string(),
                });
            }
            Some("auto_compaction_start") => {
                on_event(AgentStreamEvent::Status {
                    message: "Compressing conversation context…".to_string(),
                });
            }
            Some("auto_retry_start") | Some("retry_fallback_start") => {
                on_event(AgentStreamEvent::Status {
                    message: "Retrying after a temporary model error…".to_string(),
                });
            }
            Some("extension_error") => {
                failure = Some(
                    value
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("A Lattice agent extension failed.")
                        .to_string(),
                );
            }
            // Slash-command output. It is written for a terminal, so strip the
            // colour codes before it reaches a chat bubble.
            Some("command_output") => {
                if let Some(text) = value.get("text").and_then(Value::as_str) {
                    let plain = strip_ansi(text);
                    if !plain.trim().is_empty() {
                        if !visible.is_empty() {
                            visible.push('\n');
                        }
                        visible.push_str(plain.trim_end());
                        on_event(AgentStreamEvent::Text {
                            text: visible.clone(),
                        });
                    }
                }
            }
            Some("agent_end") => completed = true,
            Some("prompt_result")
                if value.get("id").and_then(Value::as_str) == Some("lattice-prompt")
                    && value.get("agentInvoked").and_then(Value::as_bool) == Some(false) =>
            {
                completed = true;
            }
            _ => {}
        }
        if completed && accepted {
            break;
        }
        if failure.is_some() && !accepted {
            break;
        }
    }
    let (_, stderr) = run_registration.result_or_cancelled(process.finish(false))?;
    if run_registration.was_cancelled() {
        return Err(agent_stopped_error());
    }
    if let Some(error) = failure {
        return Err(format!("{error}{}", stderr_suffix(&stderr)));
    }
    if !accepted {
        return Err(format!(
            "The agent did not accept the prompt.{}",
            stderr_suffix(&stderr)
        ));
    }
    Ok(OmpRunResult {
        summary: if visible.trim().is_empty() {
            "Finished working on the project.".to_string()
        } else {
            visible.trim().to_string()
        },
        skills_used: skills_used.into_iter().collect(),
    })
}

pub fn fork_session(
    root: &Path,
    runtime: &AgentRuntime,
    settings: &AgentSettings,
    source_session_id: &str,
    session_title: &str,
    user_message_index: usize,
    system_prompt: &str,
) -> Result<ForkedSession, String> {
    let command = omp_command(
        root,
        runtime,
        settings,
        source_session_id,
        session_title,
        system_prompt,
    )?;
    let mut process = JsonLineProcess::spawn(command, "Lattice agent")?;
    let fork_messages =
        process.request("lattice-fork-messages", "get_branch_messages", json!({}))?;
    let messages = fork_messages
        .pointer("/data/messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "OMP did not return the conversation branch points.".to_string())?;
    let entry_id = messages
        .get(user_message_index)
        .and_then(|message| message.get("entryId"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            "This conversation cannot be branched because its OMP history is incomplete."
                .to_string()
        })?;
    let source_timestamp = session_entry_timestamp(root, source_session_id, entry_id)?;
    let branch = process.request("lattice-fork", "branch", json!({ "entryId": entry_id }))?;
    if branch.pointer("/data/cancelled").and_then(Value::as_bool) == Some(true) {
        return Err("An OMP extension cancelled the conversation branch.".to_string());
    }
    let state = process.request("lattice-fork-state", "get_state", json!({}))?;
    let session_id = state
        .pointer("/data/sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "OMP did not create a conversation branch.".to_string())?
        .to_string();
    persist_session_from_state(root, &session_id, &state)?;
    if !session_title.trim().is_empty() {
        process.request(
            "lattice-fork-name",
            "set_session_name",
            json!({ "name": session_title.trim() }),
        )?;
    }
    let _ = process.finish(false)?;
    Ok(ForkedSession {
        session_id,
        source_timestamp,
    })
}

fn omp_command(
    root: &Path,
    runtime: &AgentRuntime,
    settings: &AgentSettings,
    session_id: &str,
    _session_title: &str,
    system_prompt: &str,
) -> Result<Command, String> {
    if !runtime.executable.is_file() {
        return Err(format!(
            "The bundled agent runtime is missing at {}.",
            runtime.executable.display()
        ));
    }
    if !runtime.assets.is_dir() {
        return Err(format!(
            "The bundled OMP resources are missing at {}.",
            runtime.assets.display()
        ));
    }
    ensure_omp_native(runtime);
    let active = runtime.active_executable();
    let auth = prepare_auth(runtime, &settings.provider)?;
    let session_dir = root.join(".research/omp-sessions");
    fs::create_dir_all(&session_dir).map_err(err)?;
    fs::create_dir_all(&runtime.config).map_err(err)?;
    let overlay = prepare_omp_overlay(root, runtime)?;
    let executable = active
        .to_str()
        .ok_or_else(|| "The agent runtime path is not valid UTF-8.".to_string())?;
    let mut command = commands::command(executable);
    command
        .current_dir(root)
        .env("PI_CODING_AGENT_DIR", &runtime.config)
        // How the extension's `cite` tool reaches back into Lattice: the app's
        // own executable, run as `lattice cite <query>` against this project.
        // Absent when the path cannot be resolved, and the tool then says so
        // rather than doing half the job by hand.
        .envs(
            std::env::current_exe()
                .ok()
                .map(|path| ("LATTICE_BIN", path.into_os_string())),
        )
        .env("LATTICE_PROJECT_ROOT", root)
        .arg("--mode")
        .arg("rpc")
        .arg("--model")
        .arg(format!("{}/{}", auth.provider, settings.model))
        .arg("--thinking")
        .arg(omp_thinking_level(&settings.reasoning_effort))
        .arg("--session-dir")
        .arg(&session_dir)
        .arg("--config")
        .arg(overlay)
        .arg("--no-extensions")
        .arg("--no-rules")
        .arg("--no-title")
        .arg("--auto-approve")
        .arg("--extension")
        .arg(runtime.assets.join("lattice.ts"));
    if let Some((name, value)) = auth.environment {
        command.env(name, value);
    }
    if let Some(session_file) = omp_session_file(root, session_id)? {
        command.arg("--resume").arg(session_file);
    }
    if !system_prompt.trim().is_empty() {
        command.arg("--system-prompt").arg(system_prompt.trim());
    }
    Ok(command)
}

fn prepare_omp_overlay(root: &Path, runtime: &AgentRuntime) -> Result<PathBuf, String> {
    let runtime_root = root.join(".research/omp-runtime");
    let skills_root = runtime_root.join("skills");
    if skills_root.is_dir() {
        fs::remove_dir_all(&skills_root).map_err(err)?;
    }
    fs::create_dir_all(&skills_root).map_err(err)?;
    for skill_file in skill_store::enabled_paths(root, runtime)? {
        let source = skill_file
            .parent()
            .ok_or_else(|| format!("Invalid skill path: {}", skill_file.display()))?;
        let name = source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| format!("Invalid skill path: {}", source.display()))?;
        copy_directory(source, &skills_root.join(name))?;
    }

    let skills_path = skills_root
        .to_str()
        .ok_or_else(|| "The OMP skill directory is not valid UTF-8.".to_string())?;
    let quoted_skills_path = serde_json::to_string(skills_path).map_err(err)?;
    let overlay = runtime_root.join("config.yml");
    // Keep the native provider enabled so OMP can load Lattice-managed
    // `mcp.json` files (`$PI_CODING_AGENT_DIR/mcp.json` and `.omp/mcp.json`).
    // Skills still come only from `customDirectories` below; extensions/rules
    // stay off via CLI flags. Other editors' MCP discovery is disabled so the
    // agent only sees servers configured in Lattice Settings.
    let contents = format!(
        concat!(
            "disabledProviders:\n",
            "  - claude\n",
            "  - codex\n",
            "  - gemini\n",
            "  - opencode\n",
            "  - github\n",
            "  - agents\n",
            "  - agents-md\n",
            "  - cursor\n",
            "  - vscode\n",
            "  - windsurf\n",
            "  - mcp-json\n",
            "  - omp-plugins\n",
            "  - claude-plugins\n",
            "mcp:\n",
            "  enableProjectConfig: true\n",
            "skills:\n",
            "  enabled: true\n",
            "  enableCodexUser: false\n",
            "  enableClaudeUser: false\n",
            "  enableClaudeProject: false\n",
            "  enablePiUser: false\n",
            "  enablePiProject: false\n",
            "  enableAgentsUser: false\n",
            "  enableAgentsProject: false\n",
            "  customDirectories: [{}]\n",
        ),
        quoted_skills_path,
    );
    fs::write(&overlay, contents).map_err(err)?;
    Ok(overlay)
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(err)?;
    for entry in fs::read_dir(source).map_err(err)? {
        let entry = entry.map_err(err)?;
        let target = destination.join(entry.file_name());
        if entry.file_type().map_err(err)?.is_dir() {
            copy_directory(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target).map_err(err)?;
        }
    }
    Ok(())
}

fn omp_thinking_level(level: &str) -> &str {
    match level {
        "none" => "off",
        "ultra" => "max",
        other => other,
    }
}

/// One model the runtime can actually use, as the app's picker wants it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModel {
    pub value: String,
    pub label: String,
    pub efforts: Vec<String>,
}

/// Ask the runtime which models a provider offers.
///
/// The runtime is where model support actually lives, and it moves faster than
/// this app does — a list written down here goes stale the week a model ships.
/// An empty answer is not an error: it usually means that provider is not
/// signed in yet, and the caller falls back to its own list.
pub fn list_models(runtime: &AgentRuntime, provider: &str) -> Result<Vec<AgentModel>, String> {
    let catalog = match provider {
        "codex" => "openai-codex",
        "openai-api" => "openai",
        "claude" | "anthropic-api" => "anthropic",
        _ => return Err("Choose Codex, Claude, OpenAI API, or Anthropic API.".to_string()),
    };
    let mut command = omp_cli_command(runtime)?;
    command
        .arg("models")
        .arg(catalog)
        .arg("--json")
        .arg("--no-extensions");
    let output = command
        .output()
        .map_err(|e| format!("Could not ask the agent for its models: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "The agent could not list models: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let parsed: Value = parse_cli_json(&output.stdout)
        .map_err(|e| format!("The agent's model list could not be read: {e}"))?;
    let models = parsed
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| "The agent's model list had no models.".to_string())?;
    Ok(models
        .iter()
        .filter_map(|model| parse_agent_model(model, catalog))
        .collect())
}

fn parse_agent_model(model: &Value, catalog: &str) -> Option<AgentModel> {
    if model.get("provider").and_then(Value::as_str) != Some(catalog) {
        return None;
    }
    let value = model.get("id").and_then(Value::as_str)?.to_string();
    // Dated aliases (`claude-opus-4-1-20250805`) are the same model as the
    // plain id beside them; showing both makes the picker twice as long and
    // no more useful.
    if value
        .rsplit('-')
        .next()
        .is_some_and(|tail| tail.len() == 8 && tail.chars().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    let label = model
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&value)
        .to_string();
    // The runtime's levels do not map one to one onto the app's — "minimal"
    // and "low" both land on "low" — so collapse the repeats rather than
    // offering the same rung twice.
    let mut efforts: Vec<String> = Vec::new();
    if let Some(levels) = model.get("thinking").and_then(Value::as_array) {
        for level in levels
            .iter()
            .filter_map(Value::as_str)
            .map(app_effort_level)
        {
            if !efforts.contains(&level) {
                efforts.push(level);
            }
        }
    }
    Some(AgentModel {
        value,
        label,
        efforts,
    })
}

/// The inverse of [`omp_thinking_level`], for reading the runtime's answer.
fn app_effort_level(level: &str) -> String {
    match level {
        "off" => "none",
        // The app has no separate "minimal"; its lowest rung is "low".
        "minimal" => "low",
        other => other,
    }
    .to_string()
}

fn session_map_path(root: &Path, session_id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(session_id)
        .map_err(|_| "Invalid conversation id for the OMP session.".to_string())?;
    Ok(root
        .join(".research/omp-session-map")
        .join(format!("{session_id}.json")))
}

fn omp_session_file(root: &Path, session_id: &str) -> Result<Option<PathBuf>, String> {
    let map_path = session_map_path(root, session_id)?;
    if !map_path.is_file() {
        let suffix = format!("_{session_id}.jsonl");
        let session_dir = root.join(".research/omp-sessions");
        if session_dir.is_dir() {
            if let Some(path) = fs::read_dir(&session_dir)
                .map_err(err)?
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .find(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.ends_with(&suffix))
                })
            {
                return Ok(Some(path));
            }
        }
        return migrate_legacy_pi_session(root, session_id, &suffix);
    }
    let session: OmpSessionRef =
        serde_json::from_str(&fs::read_to_string(&map_path).map_err(err)?).map_err(err)?;
    uuid::Uuid::parse_str(&session.session_id)
        .map_err(|_| "The saved OMP session id is invalid.".to_string())?;
    let file_name = Path::new(&session.file_name);
    if file_name.file_name().and_then(|name| name.to_str()) != Some(&session.file_name)
        || file_name.extension().and_then(|value| value.to_str()) != Some("jsonl")
    {
        return Err("The saved OMP session path is invalid.".to_string());
    }
    let path = root.join(".research/omp-sessions").join(file_name);
    if !path.is_file() {
        return Err(format!(
            "The OMP conversation history is missing at {}.",
            path.display()
        ));
    }
    Ok(Some(path))
}

fn migrate_legacy_pi_session(
    root: &Path,
    session_id: &str,
    suffix: &str,
) -> Result<Option<PathBuf>, String> {
    let legacy_dir = root.join(".research/pi-sessions");
    if !legacy_dir.is_dir() {
        return Ok(None);
    }
    let mut candidates = fs::read_dir(&legacy_dir)
        .map_err(err)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(suffix))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
    });
    let Some(source) = candidates.pop() else {
        return Ok(None);
    };
    let raw = fs::read_to_string(&source).map_err(err)?;
    let header = raw
        .lines()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| "The legacy Pi conversation is empty.".to_string())?;
    let header: Value = serde_json::from_str(header).map_err(err)?;
    if header.get("type").and_then(Value::as_str) != Some("session")
        || header.get("id").and_then(Value::as_str) != Some(session_id)
    {
        return Err("The legacy Pi conversation does not match this conversation.".to_string());
    }
    let file_name = source
        .file_name()
        .ok_or_else(|| "The legacy Pi conversation has no file name.".to_string())?;
    let session_dir = root.join(".research/omp-sessions");
    fs::create_dir_all(&session_dir).map_err(err)?;
    let destination = session_dir.join(file_name);
    let migrated = sanitize_legacy_pi_jsonl(&raw)?;
    fs::write(&destination, migrated).map_err(err)?;
    Ok(Some(destination))
}

fn sanitize_legacy_pi_jsonl(raw: &str) -> Result<String, String> {
    let mut lines = Vec::new();
    for line in raw.lines().filter(|line| !line.trim().is_empty()) {
        let mut value: Value = serde_json::from_str(line).map_err(err)?;
        if value.pointer("/message/role").and_then(Value::as_str) == Some("user") {
            if let Some(content) = value
                .pointer_mut("/message/content")
                .and_then(Value::as_array_mut)
            {
                for part in content {
                    if let Some(clean) = part
                        .get("text")
                        .and_then(Value::as_str)
                        .and_then(without_legacy_editor_context)
                    {
                        part["text"] = Value::String(clean.to_string());
                    }
                }
            }
        }
        lines.push(serde_json::to_string(&value).map_err(err)?);
    }
    Ok(format!("{}\n", lines.join("\n")))
}

fn without_legacy_editor_context(text: &str) -> Option<&str> {
    const START: &str = "\n\n<lattice_editor_context>";
    const END: &str = "</lattice_editor_context>";
    if !text.ends_with(END) {
        return None;
    }
    text.find(START).map(|index| &text[..index])
}

fn persist_session_from_state(
    root: &Path,
    lattice_session_id: &str,
    state: &Value,
) -> Result<(), String> {
    let omp_session_id = state
        .pointer("/data/sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "OMP did not provide a session id.".to_string())?;
    uuid::Uuid::parse_str(omp_session_id)
        .map_err(|_| "OMP returned an invalid session id.".to_string())?;
    let session_file = state
        .pointer("/data/sessionFile")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| "OMP did not provide a persistent session file.".to_string())?;
    let file_name = session_file
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| value.ends_with(".jsonl"))
        .ok_or_else(|| "OMP returned an invalid session file.".to_string())?;
    let expected_parent = root.join(".research/omp-sessions");
    if session_file.parent() != Some(expected_parent.as_path()) {
        return Err("OMP tried to place conversation history outside this project.".to_string());
    }
    let reference = OmpSessionRef {
        session_id: omp_session_id.to_string(),
        file_name: file_name.to_string(),
    };
    let path = session_map_path(root, lattice_session_id)?;
    fs::create_dir_all(path.parent().expect("OMP map path has a parent")).map_err(err)?;
    let temporary = path.with_extension("json.tmp");
    fs::write(
        &temporary,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&reference).map_err(err)?
        ),
    )
    .map_err(err)?;
    fs::rename(temporary, path).map_err(err)
}

fn session_entry_timestamp(
    root: &Path,
    session_id: &str,
    entry_id: &str,
) -> Result<Option<String>, String> {
    let Some(path) = omp_session_file(root, session_id)? else {
        return Ok(None);
    };
    for line in fs::read_to_string(path).map_err(err)?.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if entry.get("id").and_then(Value::as_str) == Some(entry_id) {
            return Ok(entry
                .get("timestamp")
                .and_then(Value::as_str)
                .map(str::to_string));
        }
    }
    Ok(None)
}

fn editor_prompt(message: &str, active_file: Option<&str>, selection: Option<&str>) -> String {
    let Some(selection) = selection.filter(|text| !text.is_empty()) else {
        return message.to_string();
    };
    let active_file = active_file
        .filter(|path| !path.trim().is_empty())
        .unwrap_or("the active editor");
    format!(
        "{message}\n\n--- Lattice editor selection from {active_file} ---\n{selection}\n--- End Lattice editor selection ---"
    )
}

fn assistant_text(message: &Value) -> Option<String> {
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let text = message
        .get("content")?
        .as_array()?
        .iter()
        .filter(|content| content.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|content| content.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    (!text.is_empty()).then_some(text)
}

fn tool_name(value: &Value) -> String {
    value
        .get("toolName")
        .and_then(Value::as_str)
        .unwrap_or("tool")
        .to_string()
}

fn tool_status(value: &Value) -> String {
    let name = tool_name(value);
    let args = value.get("args").unwrap_or(&Value::Null);
    let target = args
        .get("path")
        .or_else(|| args.get("file_path"))
        .and_then(Value::as_str);
    let command = args.get("command").and_then(Value::as_str);
    let pattern = args
        .get("pattern")
        .or_else(|| args.get("glob"))
        .or_else(|| args.get("query"))
        .and_then(Value::as_str);
    match (name.as_str(), target) {
        ("read", Some(path)) => format!("Reading {path}…"),
        ("edit" | "write", Some(path)) => format!("Editing {path}…"),
        ("bash", _) if command.is_some() => {
            format!("Running {}…", compact_tool_argument(command.unwrap()))
        }
        ("glob", _) if pattern.is_some() => {
            format!("Matching {}…", compact_tool_argument(pattern.unwrap()))
        }
        ("grep", _) if pattern.is_some() => {
            format!("Searching for {}…", compact_tool_argument(pattern.unwrap()))
        }
        ("bash", _) => "Running a project command…".to_string(),
        (_, Some(path)) => format!("Using {name} on {path}…"),
        _ => format!("Using {name}…"),
    }
}

fn compact_tool_argument(value: &str) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = compact.chars();
    let head = chars.by_ref().take(72).collect::<String>();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

fn tool_skill_name(value: &Value) -> Option<String> {
    if value.get("toolName").and_then(Value::as_str) != Some("read") {
        return None;
    }
    let path = value
        .get("args")
        .and_then(|args| args.get("path").or_else(|| args.get("file_path")))
        .and_then(Value::as_str)?;
    let components = Path::new(path)
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>();
    components.windows(3).find_map(|window| {
        (window[0] == "skills" && window[2] == "SKILL.md").then(|| window[1].to_string())
    })
}

fn compact_label(message: &str) -> String {
    let compact = message.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut value = compact.chars().take(64).collect::<String>();
    if compact.chars().count() > 64 {
        value.push('…');
    }
    value
}

fn prepare_auth(runtime: &AgentRuntime, provider: &str) -> Result<OmpAuth, String> {
    match provider {
        "codex" => {
            ensure_subscription_auth(runtime, "codex")?;
            Ok(OmpAuth {
                provider: "openai-codex",
                environment: legacy_subscription_environment(runtime, "codex"),
            })
        }
        "claude" => {
            ensure_subscription_auth(runtime, "claude")?;
            Ok(OmpAuth {
                provider: "anthropic",
                environment: legacy_subscription_environment(runtime, "claude"),
            })
        }
        "openai-api" => Ok(OmpAuth {
            provider: "openai",
            environment: Some(("OPENAI_API_KEY", load_api_key("openai")?)),
        }),
        "anthropic-api" => Ok(OmpAuth {
            provider: "anthropic",
            environment: Some(("ANTHROPIC_API_KEY", load_api_key("anthropic")?)),
        }),
        _ => Err("Choose Codex, Claude, OpenAI API, or Anthropic API.".to_string()),
    }
}

fn ensure_subscription_auth(runtime: &AgentRuntime, provider: &str) -> Result<(), String> {
    if omp_auth_marker(runtime, provider).is_file() {
        return Ok(());
    }
    if has_legacy_subscription_token(provider) {
        return Ok(());
    }
    let authenticated =
        subscription_status_result(provider, omp_provider_authenticated(runtime, provider))?;
    if authenticated {
        fs::write(omp_auth_marker(runtime, provider), "OMP\n").map_err(err)?;
        Ok(())
    } else {
        Err(subscription_sign_in_guidance(provider))
    }
}

fn subscription_status_result(
    provider: &str,
    result: Result<bool, String>,
) -> Result<bool, String> {
    result.map_err(|error| {
        format!("Could not check {provider} subscription status through OMP: {error}")
    })
}

fn has_legacy_subscription_token(provider: &str) -> bool {
    match provider {
        "codex" => codex_access_token().is_ok(),
        "claude" => claude_access_token().is_ok(),
        _ => false,
    }
}

fn omp_provider_authenticated(runtime: &AgentRuntime, provider: &str) -> Result<bool, String> {
    let omp_id = match provider {
        "codex" => "openai-codex",
        "claude" => "anthropic",
        _ => return Err("Unknown subscription provider.".to_string()),
    };
    let mut process = JsonLineProcess::spawn(omp_account_command(runtime)?, "OMP accounts")?;
    let response = process.request("lattice-login-providers", "get_login_providers", json!({}))?;
    let _ = process.finish(false)?;
    let providers = response
        .pointer("/data/providers")
        .and_then(Value::as_array)
        .ok_or_else(|| "OMP did not return its login providers.".to_string())?;
    Ok(providers.iter().any(|account| {
        account.get("id").and_then(Value::as_str) == Some(omp_id)
            && account
                .get("authenticated")
                .and_then(Value::as_bool)
                .unwrap_or(false)
    }))
}

fn subscription_sign_in_guidance(provider: &str) -> String {
    let guidance = match provider {
        "codex" => {
            "Sign in to Codex in Settings → Subscriptions before using the Codex subscription."
                .to_string()
        }
        "claude" => {
            "Sign in to Claude in Settings → Subscriptions before using the Claude subscription."
                .to_string()
        }
        _ => "Sign in through Settings → Subscriptions before using this subscription.".to_string(),
    };
    format!("{SUBSCRIPTION_AUTH_ERROR_PREFIX}{guidance}")
}

fn api_key_guidance(provider: &str) -> String {
    let guidance = match provider {
        "openai" | "openai-api" => {
            "Add an OpenAI API key in Settings → API keys before using the OpenAI API provider.".to_string()
        }
        "anthropic" | "anthropic-api" => {
            "Add an Anthropic API key in Settings → API keys before using the Anthropic API provider.".to_string()
        }
        _ => "Add an API key in Settings → API keys before using this provider.".to_string(),
    };
    format!("{API_KEY_AUTH_ERROR_PREFIX}{guidance}")
}

fn rewrite_agent_auth_error(runtime: &AgentRuntime, provider: &str, error: &str) -> String {
    if !looks_like_missing_auth_error(error) {
        return error.to_string();
    }
    match provider {
        "codex" | "claude" => {
            let _ = fs::remove_file(omp_auth_marker(runtime, provider));
            subscription_sign_in_guidance(provider)
        }
        "openai-api" | "anthropic-api" => api_key_guidance(provider),
        _ => error.to_string(),
    }
}

fn looks_like_missing_auth_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("no api key found")
        || lower.contains("use /login")
        || lower.contains("no credentials")
        || lower.contains("not authenticated")
}

fn legacy_subscription_environment(
    runtime: &AgentRuntime,
    provider: &str,
) -> Option<(&'static str, String)> {
    if omp_auth_marker(runtime, provider).is_file() {
        return None;
    }
    match provider {
        "codex" => codex_access_token()
            .ok()
            .map(|token| ("OPENAI_CODEX_OAUTH_TOKEN", token)),
        "claude" => claude_access_token()
            .ok()
            .map(|token| ("ANTHROPIC_OAUTH_TOKEN", token)),
        _ => None,
    }
}

fn omp_auth_marker(runtime: &AgentRuntime, provider: &str) -> PathBuf {
    runtime.config.join(format!("lattice-{provider}-auth"))
}

fn codex_access_token() -> Result<String, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "Could not find the current user folder.".to_string())?;
    let raw = fs::read_to_string(home.join(".codex/auth.json"))
        .map_err(|_| "Sign in to Codex before using the Codex subscription.".to_string())?;
    let value: Value = serde_json::from_str(&raw).map_err(err)?;
    let access = value
        .pointer("/tokens/access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "The Codex sign-in does not contain an access token.".to_string())?;
    let _expires = jwt_expiry_ms(access).ok_or_else(|| {
        "The Codex access token has an unreadable expiration time. Sign in again.".to_string()
    })?;
    Ok(access.to_string())
}

fn claude_access_token() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("/usr/bin/security")
            .args([
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-w",
            ])
            .output()
            .map_err(|error| format!("Could not read the Claude sign-in: {error}"))?;
        if !output.status.success() {
            return Err("Sign in to Claude Code before using the Claude subscription.".to_string());
        }
        let value: Value = serde_json::from_slice(&output.stdout).map_err(err)?;
        let oauth = value.get("claudeAiOauth").ok_or_else(|| {
            "The Claude Code sign-in does not contain OAuth credentials.".to_string()
        })?;
        let access = oauth
            .get("accessToken")
            .and_then(Value::as_str)
            .ok_or_else(|| "The Claude sign-in does not contain an access token.".to_string())?;
        let _expires = oauth
            .get("expiresAt")
            .and_then(Value::as_u64)
            .ok_or_else(|| "The Claude sign-in has an unreadable expiration time.".to_string())?;
        Ok(access.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    Err("Claude subscription sign-in is currently supported on macOS.".to_string())
}

fn jwt_expiry_ms(token: &str) -> Option<u64> {
    let payload = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let value: Value = serde_json::from_slice(&decoded).ok()?;
    value.get("exp")?.as_u64()?.checked_mul(1000)
}

/// Drop ANSI SGR/CSI sequences and the odd OSC hyperlink from terminal output.
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(character) = chars.next() {
        if character != '\u{1b}' {
            out.push(character);
            continue;
        }
        match chars.next() {
            // CSI: parameters and intermediates, then one final byte.
            Some('[') => {
                for next in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&next) {
                        break;
                    }
                }
            }
            // OSC: runs until BEL or ST (ESC \).
            Some(']') => {
                while let Some(next) = chars.next() {
                    if next == '\u{7}' {
                        break;
                    }
                    if next == '\u{1b}' {
                        chars.next();
                        break;
                    }
                }
            }
            // Two-character escapes; the second byte is part of the sequence.
            Some(_) => {}
            None => {}
        }
    }
    out
}

fn stderr_suffix(stderr: &str) -> String {
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("\n{trimmed}")
    }
}

fn agent_stopped_error() -> String {
    format!("{AGENT_STOPPED_ERROR_PREFIX}The agent was stopped.")
}

fn schedule_forced_stop(process_id: u32, process_lifecycle: Arc<ProcessLifecycle>) {
    thread::spawn(move || {
        if !process_lifecycle.wait_for_exit(CANCEL_GRACE_PERIOD) {
            process_lifecycle.terminate_once(process_id);
        }
    });
}

#[cfg(unix)]
fn terminate_process_tree(process_id: u32) {
    let Ok(process_group) = i32::try_from(process_id) else {
        return;
    };
    // The sidecar is spawned as its own process-group leader, so a negative
    // pid terminates OMP and any shell tools it started.
    unsafe {
        libc::kill(-process_group, libc::SIGKILL);
    }
}

#[cfg(windows)]
fn terminate_process_tree(process_id: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn write_json_line(
    stdin: &Arc<Mutex<ChildStdin>>,
    value: &Value,
    label: &str,
) -> Result<(), String> {
    let mut stdin = stdin
        .lock()
        .map_err(|_| format!("{label} input is unavailable."))?;
    serde_json::to_writer(&mut *stdin, value).map_err(err)?;
    stdin.write_all(b"\n").map_err(err)?;
    stdin.flush().map_err(err)
}

struct JsonLineProcess {
    child: Child,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    lines: Receiver<Result<Option<String>, String>>,
    stderr: Option<JoinHandle<Result<String, String>>>,
    process_lifecycle: Arc<ProcessLifecycle>,
    deadline: Instant,
    label: &'static str,
    finished: bool,
}

impl JsonLineProcess {
    fn spawn(mut command: Command, label: &'static str) -> Result<Self, String> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not start {label}: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("Could not open {label} input."))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("Could not capture {label} output."))?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| format!("Could not capture {label} errors."))?;
        let (sender, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if sender
                    .send(line.map(Some).map_err(|error| error.to_string()))
                    .is_err()
                {
                    return;
                }
            }
            let _ = sender.send(Ok(None));
        });
        let stderr = thread::spawn(move || {
            let mut output = String::new();
            stderr
                .read_to_string(&mut output)
                .map_err(|error| error.to_string())?;
            Ok(output)
        });
        let process_lifecycle = Arc::new(ProcessLifecycle::new());
        Ok(Self {
            child,
            stdin: Some(Arc::new(Mutex::new(stdin))),
            lines,
            stderr: Some(stderr),
            process_lifecycle,
            deadline: Instant::now() + AGENT_TIMEOUT,
            label,
            finished: false,
        })
    }

    fn id(&self) -> u32 {
        self.child.id()
    }

    fn stdin_handle(&self) -> Weak<Mutex<ChildStdin>> {
        self.stdin.as_ref().map(Arc::downgrade).unwrap_or_default()
    }

    fn lifecycle_handle(&self) -> Arc<ProcessLifecycle> {
        Arc::clone(&self.process_lifecycle)
    }

    fn send(&self, value: &Value) -> Result<(), String> {
        let stdin = self
            .stdin
            .as_ref()
            .ok_or_else(|| format!("{} input is closed.", self.label))?;
        write_json_line(stdin, value, self.label)
    }

    fn next_value(&self) -> Result<Option<Value>, String> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!("{} did not respond within 10 minutes.", self.label));
        }
        match self.lines.recv_timeout(remaining) {
            Ok(Ok(Some(line))) => serde_json::from_str(&line)
                .map(Some)
                .map_err(|error| format!("Could not parse {} output: {error}", self.label)),
            Ok(Ok(None)) => Ok(None),
            Ok(Err(error)) => Err(format!("Could not read {} output: {error}", self.label)),
            Err(RecvTimeoutError::Timeout) => {
                Err(format!("{} did not respond within 10 minutes.", self.label))
            }
            Err(RecvTimeoutError::Disconnected) => Ok(None),
        }
    }

    /// Drain whatever the sidecar wrote to stderr (best-effort). Used to turn an
    /// opaque "stopped before responding" into a diagnosable message.
    fn drain_stderr(&mut self) -> String {
        match self.stderr.take() {
            Some(handle) => handle
                .join()
                .ok()
                .and_then(|result| result.ok())
                .unwrap_or_default(),
            None => String::new(),
        }
    }

    fn request(&mut self, id: &str, command: &str, fields: Value) -> Result<Value, String> {
        let mut value = fields.as_object().cloned().unwrap_or_default();
        value.insert("id".to_string(), Value::String(id.to_string()));
        value.insert("type".to_string(), Value::String(command.to_string()));
        self.send(&Value::Object(value))?;
        loop {
            let response = match self.next_value()? {
                Some(response) => response,
                None => {
                    let stderr = self.drain_stderr();
                    let detail = sidecar_error_detail(&stderr);
                    return Err(format!(
                        "{} stopped before responding to {command}.{detail}",
                        self.label
                    ));
                }
            };
            if response.get("type").and_then(Value::as_str) != Some("response")
                || response.get("id").and_then(Value::as_str) != Some(id)
            {
                continue;
            }
            if response.get("success").and_then(Value::as_bool) != Some(true) {
                return Err(response
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("OMP rejected the request.")
                    .to_string());
            }
            return Ok(response);
        }
    }

    fn finish(&mut self, terminate: bool) -> Result<(ExitStatus, String), String> {
        self.stdin.take();
        if terminate {
            self.process_lifecycle.terminate_once(self.child.id());
            let _ = self.child.kill();
        }
        let status = self.child.wait().map_err(|error| {
            self.process_lifecycle.terminate_once(self.child.id());
            format!("Could not stop {}: {error}", self.label)
        })?;
        self.process_lifecycle.mark_exited();
        self.finished = true;
        let stderr = self
            .stderr
            .take()
            .ok_or_else(|| format!("Could not read {} errors.", self.label))?
            .join()
            .map_err(|_| format!("Could not read {} errors.", self.label))??;
        Ok((status, stderr))
    }
}

impl Drop for JsonLineProcess {
    fn drop(&mut self) {
        if !self.finished {
            self.process_lifecycle.terminate_once(self.child.id());
            let _ = self.child.kill();
            let _ = self.child.wait();
            self.process_lifecycle.mark_exited();
            self.finished = true;
        }
        if let Some(stderr) = self.stderr.take() {
            let _ = stderr.join();
        }
    }
}

pub fn save_api_key(provider: &str, key: &str) -> Result<(), String> {
    let provider = keychain_provider(provider)?;
    if key.trim().is_empty() {
        return Err("Enter an API key.".to_string());
    }
    keyring::Entry::new("app.leo1oel.researchwriter", provider)
        .map_err(err)?
        .set_password(key.trim())
        .map_err(|error| format!("Could not save the key in macOS Keychain: {error}"))
}

pub fn delete_api_key(provider: &str) -> Result<(), String> {
    let provider = keychain_provider(provider)?;
    let entry = keyring::Entry::new("app.leo1oel.researchwriter", provider).map_err(err)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "Could not remove the key from macOS Keychain: {error}"
        )),
    }
}

pub fn api_key_status() -> Vec<(String, bool)> {
    ["openai", "anthropic"]
        .into_iter()
        .map(|provider| (provider.to_string(), load_api_key(provider).is_ok()))
        .collect()
}

fn load_api_key(provider: &str) -> Result<String, String> {
    let provider = keychain_provider(provider)?;
    keyring::Entry::new("app.leo1oel.researchwriter", provider)
        .map_err(err)?
        .get_password()
        .map_err(|_| api_key_guidance(provider))
}

fn keychain_provider(provider: &str) -> Result<&str, String> {
    match provider {
        "openai" | "anthropic" => Ok(provider),
        _ => Err("Unknown API key provider.".to_string()),
    }
}

/// The slash commands this OMP build offers. OMP announces them unprompted, as
/// an `available_commands_update` right after `ready`, so we start a throwaway
/// session and read the first one rather than asking for anything.
pub fn list_agent_commands(runtime: &AgentRuntime) -> Result<Vec<AgentCommand>, String> {
    let mut process = JsonLineProcess::spawn(omp_account_command(runtime)?, "OMP commands")?;
    let mut commands = Vec::new();
    while let Some(value) = process.next_value()? {
        if value.get("type").and_then(Value::as_str) != Some("available_commands_update") {
            continue;
        }
        for entry in value
            .get("commands")
            .and_then(Value::as_array)
            .unwrap_or(&Vec::new())
        {
            let Some(name) = entry.get("name").and_then(Value::as_str) else {
                continue;
            };
            commands.push(AgentCommand {
                name: name.to_string(),
                description: entry
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                hint: entry
                    .pointer("/input/hint")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                subcommands: entry
                    .get("subcommands")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| item.get("name").and_then(Value::as_str))
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default(),
            });
        }
        break;
    }
    let _ = process.finish(true)?;
    commands.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(commands)
}

pub fn subscription_status(runtime: &AgentRuntime) -> Result<Vec<SubscriptionStatus>, String> {
    let mut process = JsonLineProcess::spawn(omp_account_command(runtime)?, "OMP accounts")?;
    let response = process.request("lattice-login-providers", "get_login_providers", json!({}))?;
    let _ = process.finish(false)?;
    let providers = response
        .pointer("/data/providers")
        .and_then(Value::as_array)
        .ok_or_else(|| "OMP did not return its login providers.".to_string())?;
    [
        ("codex", "openai-codex", "ChatGPT Codex subscription"),
        ("claude", "anthropic", "Claude Pro or Max subscription"),
    ]
    .into_iter()
    .map(|(provider, omp_id, fallback_name)| {
        let account = providers
            .iter()
            .find(|account| account.get("id").and_then(Value::as_str) == Some(omp_id));
        let installed = account
            .and_then(|account| account.get("available"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let logged_in = account
            .and_then(|account| account.get("authenticated"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if logged_in {
            fs::write(omp_auth_marker(runtime, provider), "OMP\n").map_err(err)?;
        }
        let name = account
            .and_then(|account| account.get("name"))
            .and_then(Value::as_str)
            .unwrap_or(fallback_name);
        Ok(SubscriptionStatus {
            provider: provider.to_string(),
            installed,
            logged_in,
            detail: if logged_in {
                format!("Connected through OMP · {name}")
            } else if installed {
                format!("Sign in through OMP · {name}")
            } else {
                format!("This OMP build does not provide {name}.")
            },
        })
    })
    .collect()
}

pub fn begin_subscription_login(
    runtime: &AgentRuntime,
    provider: &str,
    on_event: &dyn Fn(SubscriptionLoginEvent),
) -> Result<(), String> {
    let provider_id = match provider {
        "codex" => "openai-codex",
        "claude" => "anthropic",
        _ => return Err("Unknown OMP subscription provider.".to_string()),
    };
    let mut process = JsonLineProcess::spawn(omp_account_command(runtime)?, "OMP sign-in")?;
    process.send(&json!({
        "id": "lattice-login",
        "type": "login",
        "providerId": provider_id,
    }))?;
    let mut opened_browser = false;
    loop {
        let value = process
            .next_value()?
            .ok_or_else(|| "OMP stopped before sign-in completed.".to_string())?;
        if value.get("type").and_then(Value::as_str) == Some("extension_ui_request") {
            match value.get("method").and_then(Value::as_str) {
                Some("open_url") => {
                    let url = value
                        .get("launchUrl")
                        .or_else(|| value.get("url"))
                        .and_then(Value::as_str)
                        .ok_or_else(|| "OMP returned an invalid sign-in URL.".to_string())?;
                    open_browser(url)?;
                    opened_browser = true;
                    let message = value
                        .get("instructions")
                        .and_then(Value::as_str)
                        .unwrap_or("Complete sign-in in your browser.");
                    on_event(SubscriptionLoginEvent {
                        message: message.to_string(),
                    });
                }
                Some("notify") => {
                    if let Some(message) = value.get("message").and_then(Value::as_str) {
                        on_event(SubscriptionLoginEvent {
                            message: message.to_string(),
                        });
                    }
                }
                Some("input") if opened_browser => {
                    on_event(SubscriptionLoginEvent {
                        message: "Waiting for the browser to return the authorization to OMP…"
                            .to_string(),
                    });
                }
                _ => {}
            }
            continue;
        }
        if value.get("type").and_then(Value::as_str) != Some("response")
            || value.get("id").and_then(Value::as_str) != Some("lattice-login")
        {
            continue;
        }
        if value.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("OMP sign-in failed.")
                .to_string());
        }
        fs::write(omp_auth_marker(runtime, provider), "OMP\n").map_err(err)?;
        on_event(SubscriptionLoginEvent {
            message: "Connected. OMP will manage and refresh this subscription.".to_string(),
        });
        let _ = process.finish(false)?;
        return Ok(());
    }
}

/// Oh My Pi loads a ~130 MB native module from `~/.omp/natives/<version>/` and,
/// when it is missing, downloads it from a GitHub release asset that no longer
/// exists — so on any machine without a cached copy OMP 404s and crashes on first
/// use (Settings → Subscriptions, or running the agent). We bundle the native
/// (see prepare-omp-sidecar.mjs) and pre-place it here so no download is needed.
/// Best-effort: any failure just leaves OMP to its own (doomed) download path.
fn ensure_omp_native(runtime: &AgentRuntime) {
    let Some(filename) = omp_native_filename() else {
        return;
    };
    // Keyed on the version that will run: an updated runtime looks for its
    // own native module, and finding the previous one there would either fail
    // to load or send it off to download a replacement.
    let Some(version) = runtime.running_version() else {
        return;
    };
    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let target = PathBuf::from(home)
        .join(".omp")
        .join("natives")
        .join(&version)
        .join(filename);
    // Already present at a plausible size — nothing to do.
    if target
        .metadata()
        .map(|meta| meta.len() > 1_000_000)
        .unwrap_or(false)
    {
        return;
    }
    // An installed update carries its own; the bundle's copy is the fallback.
    let source = crate::omp_update::resolve_native(&runtime.config, &version)
        .unwrap_or_else(|| runtime.assets.join("natives").join(filename));
    if !source.is_file() {
        return;
    }
    let Some(parent) = target.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    // Copy to a temp path then rename, so a partial copy is never seen as done.
    let tmp = parent.join(format!("{filename}.partial"));
    if fs::copy(&source, &tmp).is_ok() {
        let _ = fs::rename(&tmp, &target);
    } else {
        let _ = fs::remove_file(&tmp);
    }
}

fn omp_native_filename() -> Option<&'static str> {
    if cfg!(all(target_arch = "aarch64", target_os = "macos")) {
        Some("pi_natives.darwin-arm64.node")
    } else if cfg!(all(target_arch = "x86_64", target_os = "macos")) {
        Some("pi_natives.darwin-x64.node")
    } else if cfg!(all(target_arch = "aarch64", target_os = "linux")) {
        Some("pi_natives.linux-arm64.node")
    } else if cfg!(all(target_arch = "x86_64", target_os = "linux")) {
        Some("pi_natives.linux-x64.node")
    } else if cfg!(all(target_arch = "x86_64", target_os = "windows")) {
        Some("pi_natives.win32-x64.node")
    } else {
        None
    }
}

/// The bundled OMP version, read from the shipped omp-assets/package.json.
fn omp_bundled_version(runtime: &AgentRuntime) -> Option<String> {
    let raw = fs::read_to_string(runtime.assets.join("package.json")).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    value.get("version")?.as_str().map(str::to_string)
}

/// The runtime invoked as a plain command-line tool.
///
/// Deliberately not [`omp_account_command`], which builds the long form used
/// to run the agent itself — `--mode rpc`, a model, no tools. Appending a
/// subcommand to that produces a command line the runtime does not recognise,
/// and it answers with a terminal reset instead of the JSON we asked for.
fn omp_cli_command(runtime: &AgentRuntime) -> Result<Command, String> {
    if !runtime.executable.is_file() {
        return Err(format!(
            "The bundled OMP executable is missing at {}.",
            runtime.executable.display()
        ));
    }
    ensure_omp_native(runtime);
    fs::create_dir_all(&runtime.config).map_err(err)?;
    let executable = runtime.active_executable();
    let executable = executable
        .to_str()
        .ok_or_else(|| "The OMP executable path is not valid UTF-8.".to_string())?;
    let mut command = commands::command(executable);
    command
        .current_dir(&runtime.config)
        .env("PI_CODING_AGENT_DIR", &runtime.config);
    Ok(command)
}

/// Read JSON out of a command's stdout, ignoring any terminal control the
/// runtime printed around it.
///
/// It restores the terminal on the way out, and on some paths that lands ahead
/// of the payload. Looking for the first brace is not enough — an escape
/// sequence like `ESC [ ? 2 5 h` contains a bracket of its own — so the escapes
/// are removed first and the JSON found in what is left.
fn parse_cli_json(stdout: &[u8]) -> Result<Value, String> {
    let text = strip_terminal_escapes(&String::from_utf8_lossy(stdout));
    let start = text
        .find(['{', '['])
        .ok_or_else(|| "the runtime printed no JSON".to_string())?;
    serde_json::from_str(&text[start..]).map_err(|e| e.to_string())
}

/// Drop ANSI escape sequences.
///
/// A control sequence is an escape, `[`, parameter bytes, then a final byte in
/// `@`..`~`. The introducing `[` is itself in that range, so it has to be
/// consumed before the search for the end begins — scanning naively ends the
/// sequence on its own first character and leaves the parameters behind.
fn strip_terminal_escapes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            out.push(ch);
            continue;
        }
        match chars.peek() {
            Some('[') => {
                chars.next();
                for escaped in chars.by_ref() {
                    if ('@'..='~').contains(&escaped) {
                        break;
                    }
                }
            }
            // An operating-system command runs to a bell or a string
            // terminator rather than to a single final byte.
            Some(']') => {
                chars.next();
                while let Some(escaped) = chars.next() {
                    if escaped == '\u{7}' {
                        break;
                    }
                    if escaped == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            // Anything else is a two-character escape.
            Some(_) => {
                chars.next();
            }
            None => {}
        }
    }
    out
}

fn omp_account_command(runtime: &AgentRuntime) -> Result<Command, String> {
    if !runtime.executable.is_file() {
        return Err(format!(
            "The bundled OMP executable is missing at {}.",
            runtime.executable.display()
        ));
    }
    ensure_omp_native(runtime);
    let runtime = &AgentRuntime {
        executable: runtime.active_executable(),
        ..runtime.clone()
    };
    fs::create_dir_all(&runtime.config).map_err(err)?;
    let executable = runtime
        .executable
        .to_str()
        .ok_or_else(|| "The OMP executable path is not valid UTF-8.".to_string())?;
    let mut command = commands::command(executable);
    command
        .current_dir(&runtime.config)
        .env("PI_CODING_AGENT_DIR", &runtime.config)
        .arg("--mode")
        .arg("rpc")
        .arg("--no-session")
        .arg("--no-tools")
        .arg("--no-extensions")
        .arg("--no-skills")
        .arg("--no-rules")
        .arg("--no-title")
        .arg("--model")
        .arg("openai-codex/gpt-5.6-sol");
    Ok(command)
}

fn open_browser(url: &str) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("OMP returned a sign-in URL with an unsupported scheme.".to_string());
    }
    #[cfg(target_os = "macos")]
    let mut command = Command::new("/usr/bin/open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.arg("/C").arg("start").arg("");
        command
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = Command::new("xdg-open");
    command
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open the OMP sign-in page: {error}"))
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Format a sidecar's captured stderr into a short, appendable error detail.
/// A Bun/Node uncaught exception prints the error MESSAGE first, then a run of
/// "at …" stack frames; naively taking the last lines shows only frames and
/// hides the message. So skip the trailing frames and surface the message line
/// (plus one frame for locality), capped so a verbose log never floods the UI.
fn sidecar_error_detail(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        return String::new();
    }
    let is_frame = |line: &&str| {
        let l = line.trim_start_matches(['•', '-', ' ']);
        l.starts_with("at ") || l.starts_with("at<") || l.starts_with("at@")
    };
    // A thrown error usually announces itself. Prefer the first such line:
    // runtimes like bun print the cause up front and then pad the tail with
    // recovery hints (e.g. a `curl` command to fetch a native addon by hand),
    // and reporting the hint instead of the cause sends debugging sideways.
    let is_error_headline = |line: &&str| {
        let l = line.trim_start_matches(['•', '-', ' ']);
        l.starts_with("error:")
            || l.starts_with("Error:")
            || l.split_once(':')
                .is_some_and(|(head, _)| head.ends_with("Error") && !head.contains(' '))
    };
    // Otherwise the last non-frame line, since frames come after the message.
    let message_index = lines
        .iter()
        .position(is_error_headline)
        .or_else(|| lines.iter().rposition(|line| !is_frame(line)))
        .unwrap_or(0);
    let detail = lines[message_index..]
        .iter()
        .take(3)
        .copied()
        .collect::<Vec<_>>()
        .join(" · ");
    if detail.is_empty() {
        return String::new();
    }
    let capped: String = detail.chars().take(500).collect();
    format!(" Details: {capped}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachments_validate_content_and_build_omp_images_and_text() {
        let root =
            std::env::temp_dir().join(format!("lattice-attachments-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let image = root.join("spoof.txt");
        let image_bytes = STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
            .unwrap();
        fs::write(&image, &image_bytes).unwrap();
        let text_path = root.join("notes.md");
        fs::write(&text_path, "useful notes").unwrap();
        let descriptors = vec![
            AgentAttachmentDescriptor {
                path: image.display().to_string(),
                name: "spoof.txt".into(),
            },
            AgentAttachmentDescriptor {
                path: text_path.display().to_string(),
                name: "notes.md".into(),
            },
        ];
        let loaded = load_attachments(&descriptors, false).unwrap();
        assert!(loaded
            .text
            .contains("<file name=\"notes.md\">\nuseful notes\n</file>"));
        assert_eq!(loaded.images[0]["type"], "image");
        assert_eq!(loaded.images[0]["mimeType"], "image/png");
        assert_eq!(loaded.metadata[0].kind, "image");
        assert_eq!(loaded.metadata[1].kind, "text");
        assert_eq!(loaded.images[0]["data"], STANDARD.encode(&image_bytes));
        assert!(loaded
            .metadata
            .iter()
            .all(|metadata| metadata.preview_url.is_none()));

        let inspected = inspect_attachments(&descriptors[..1]).unwrap();
        let preview = inspected[0]
            .preview_url
            .as_deref()
            .expect("inspection should produce a bounded image preview");
        assert!(preview.starts_with("data:image/jpeg;base64,"));
        assert_ne!(
            preview,
            format!("data:image/png;base64,{}", STANDARD.encode(&image_bytes))
        );

        let malformed_image = root.join("malformed.png");
        fs::write(&malformed_image, b"\x89PNG\r\n\x1a\ncontent").unwrap();
        assert!(load_attachments(
            &[AgentAttachmentDescriptor {
                path: malformed_image.display().to_string(),
                name: "malformed.png".into(),
            }],
            false
        )
        .unwrap_err()
        .contains("UTF-8"));

        fs::write(&text_path, b"bad\0text").unwrap();
        assert!(load_attachments(&descriptors[1..], false)
            .unwrap_err()
            .contains("NUL"));
        fs::write(&text_path, b"\xff\xfe").unwrap();
        assert!(load_attachments(&descriptors[1..], false)
            .unwrap_err()
            .contains("UTF-8"));
        let missing = AgentAttachmentDescriptor {
            path: root.join("missing").display().to_string(),
            name: "missing".into(),
        };
        assert!(load_attachments(&[missing], false)
            .unwrap_err()
            .contains("no longer exists"));
        let directory = AgentAttachmentDescriptor {
            path: root.display().to_string(),
            name: "folder".into(),
        };
        assert!(load_attachments(&[directory], false)
            .unwrap_err()
            .contains("regular file"));
        let svg = root.join("diagram.txt");
        fs::write(&svg, "<?xml version=\"1.0\"?><svg></svg>").unwrap();
        assert!(load_attachments(
            &[AgentAttachmentDescriptor {
                path: svg.display().to_string(),
                name: "diagram.txt".into(),
            }],
            false
        )
        .unwrap_err()
        .contains("not a supported PDF"));
        let too_many = (0..=MAX_ATTACHMENTS)
            .map(|_| AgentAttachmentDescriptor {
                path: image.display().to_string(),
                name: "image.png".into(),
            })
            .collect::<Vec<_>>();
        assert!(load_attachments(&too_many, false)
            .unwrap_err()
            .contains("at most 8 files"));

        let oversized = root.join("oversized.txt");
        fs::File::create(&oversized)
            .unwrap()
            .set_len(MAX_ATTACHMENT_BYTES + 1)
            .unwrap();
        let error = load_attachments(
            &[AgentAttachmentDescriptor {
                path: oversized.display().to_string(),
                name: "oversized.txt".into(),
            }],
            false,
        )
        .unwrap_err();
        assert!(error.contains("20 MiB per-file limit"), "{error}");
        fs::remove_dir_all(root).unwrap();
    }

    /// Asks the real bundled runtime for its models, using the app's own
    /// config directory — which is where the signed-in accounts live, and so
    /// the only place the answer is non-empty.
    #[test]
    #[ignore = "runs the bundled agent against the signed-in accounts"]
    fn lists_models_from_the_real_runtime() {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let runtime = AgentRuntime::new(
            manifest
                .join("binaries")
                .join("lattice-agent-aarch64-apple-darwin"),
            manifest.join("omp-assets"),
            PathBuf::from(std::env::var("HOME").unwrap())
                .join("Library/Application Support/app.leo1oel.researchwriter/omp"),
        );
        for provider in ["claude", "codex", "anthropic-api", "openai-api"] {
            match list_models(&runtime, provider) {
                Ok(models) => {
                    println!("{provider}: {} models", models.len());
                    for model in models.iter().take(6) {
                        println!("    {} — {} {:?}", model.value, model.label, model.efforts);
                    }
                }
                Err(reason) => println!("{provider}: {reason}"),
            }
        }
        // Whatever else is signed in, the answer must parse.
        assert!(list_models(&runtime, "claude").is_ok());
    }

    #[test]
    fn cli_json_survives_a_terminal_reset_prologue() {
        // The runtime restores the terminal on its way out; on some paths that
        // lands ahead of the payload and would otherwise fail the parse.
        let prologue = "\u{1b}[?25h";
        assert_eq!(
            parse_cli_json(format!("{prologue}{{\"models\":[]}}\n").as_bytes()).unwrap(),
            serde_json::json!({"models": []})
        );
        assert_eq!(
            parse_cli_json(br#"{"models":[]}"#).unwrap(),
            serde_json::json!({"models": []})
        );
        assert!(parse_cli_json(prologue.as_bytes()).is_err());
        // The bracket inside the escape sequence is not the start of an array.
        assert_eq!(strip_terminal_escapes("\u{1b}[?25h{}"), "{}");
        assert_eq!(
            parse_cli_json(format!("{prologue}[1,2]").as_bytes()).unwrap(),
            serde_json::json!([1, 2])
        );
    }

    #[test]
    fn model_entries_drop_dated_aliases_and_map_thinking_levels() {
        let opus = parse_agent_model(
            &serde_json::json!({
                "provider": "anthropic",
                "id": "claude-opus-4-1",
                "name": "Claude Opus 4.1",
                "thinking": ["minimal", "low", "medium", "high", "xhigh"],
            }),
            "anthropic",
        )
        .expect("a model");
        assert_eq!(opus.value, "claude-opus-4-1");
        assert_eq!(opus.label, "Claude Opus 4.1");
        // The app has no "minimal"; its lowest rung is "low", and the two
        // must not both appear or the effort menu shows the same thing twice.
        assert_eq!(opus.efforts, vec!["low", "medium", "high", "xhigh"]);

        // The dated alias is the same model as the plain id beside it.
        assert!(parse_agent_model(
            &serde_json::json!({
                "provider": "anthropic",
                "id": "claude-opus-4-1-20250805",
                "name": "Claude Opus 4.1",
            }),
            "anthropic",
        )
        .is_none());

        // Another provider's models never leak into this list.
        assert!(parse_agent_model(
            &serde_json::json!({"provider": "openai", "id": "gpt-5.6-sol"}),
            "anthropic",
        )
        .is_none());
    }

    #[test]
    fn sidecar_detail_surfaces_the_error_message_not_just_stack_frames() {
        let stderr = "\
some startup noise
Error: keychain access denied
    at getProviders (cli.ts:47:37)
    at handle (cli.ts:712834:5)
    at main (cli.ts:47:37)";
        let detail = sidecar_error_detail(stderr);
        assert!(detail.contains("keychain access denied"), "got: {detail}");
        // The message line must lead, not be buried behind frames.
        assert!(
            detail.starts_with(" Details: Error: keychain access denied"),
            "got: {detail}"
        );
    }

    #[test]
    fn sidecar_detail_reports_the_cause_not_the_trailing_recovery_hint() {
        // Shape of a real bun failure: the cause is printed first, then a long
        // tail of "here is how to fix it by hand" advice.
        let stderr = "\
error: Failed to load pi_natives native addon for darwin-arm64.
Tried:
- /Users/leo/.omp/natives/17.0.5/pi_natives.darwin-arm64.node: dlopen failed
If missing, delete /Users/leo/.omp/natives/17.0.5 and re-run, or download manually:
  curl -fsSL \"https://github.com/can1357/oh-my-pi/releases/latest/download/pi_natives.darwin-arm64.node\"";
        let detail = sidecar_error_detail(stderr);
        assert!(
            detail.starts_with(" Details: error: Failed to load pi_natives native addon"),
            "got: {detail}"
        );
        assert!(!detail.contains("curl -fsSL"), "got: {detail}");
    }

    #[test]
    fn strips_terminal_colour_codes_from_command_output() {
        // Shape of real `/context` output.
        let raw = "Context window: 372000 tokens\n  System prompt \u{1b}[38;2;107;114;128m\u{2591}\u{2591}\u{1b}[39m 2%\n";
        let plain = strip_ansi(raw);
        assert!(!plain.contains('\u{1b}'), "got: {plain:?}");
        assert!(plain.contains("Context window: 372000 tokens"));
        assert!(plain.contains("2%"));
    }

    #[test]
    fn leaves_ordinary_text_untouched() {
        let text = "No escapes here — just prose with 100% and [brackets].";
        assert_eq!(strip_ansi(text), text);
    }

    #[test]
    fn sidecar_detail_is_empty_for_blank_stderr() {
        assert_eq!(sidecar_error_detail("   \n\n  "), "");
    }

    #[test]
    fn adds_only_an_explicit_editor_selection_without_hidden_xml() {
        let prompt = editor_prompt(
            "Revise this.",
            Some("sections/method.tex"),
            Some("old text"),
        );
        assert!(prompt.starts_with("Revise this."));
        assert!(prompt.contains("sections/method.tex"));
        assert!(prompt.contains("old text"));
        assert!(!prompt.contains("<lattice_editor_context>"));
    }

    #[test]
    fn leaves_messages_untouched_without_editor_context() {
        assert_eq!(editor_prompt("Hello", None, None), "Hello");
        assert_eq!(editor_prompt("Hello", Some("main.tex"), None), "Hello");
    }

    #[test]
    fn never_renders_a_user_message_as_assistant_text() {
        let user = json!({
            "role": "user",
            "content": [{"type": "text", "text": "Why repeat this?"}]
        });
        let assistant = json!({
            "role": "assistant",
            "content": [{"type": "text", "text": "I will not."}]
        });
        assert_eq!(assistant_text(&user), None);
        assert_eq!(assistant_text(&assistant).as_deref(), Some("I will not."));
    }

    #[test]
    fn creates_short_history_labels() {
        assert!(compact_label(&"word ".repeat(30)).chars().count() <= 65);
    }

    #[test]
    fn maps_lattice_effort_names_to_omp() {
        assert_eq!(omp_thinking_level("none"), "off");
        assert_eq!(omp_thinking_level("high"), "high");
        assert_eq!(omp_thinking_level("ultra"), "max");
    }

    #[test]
    fn records_skills_read_by_omp_tools() {
        let skill_read = json!({
            "toolName": "read",
            "args": {
                "path": "/paper/.research/omp-runtime/skills/research-taste/SKILL.md"
            }
        });
        let ordinary_read = json!({
            "toolName": "read",
            "args": { "path": "/paper/main.tex" }
        });
        assert_eq!(
            tool_skill_name(&skill_read).as_deref(),
            Some("research-taste")
        );
        assert_eq!(tool_skill_name(&ordinary_read), None);
    }

    #[test]
    fn describes_tool_targets_in_stream_events() {
        assert_eq!(
            tool_status(&json!({ "toolName": "read", "args": { "path": "src/main.ts" } })),
            "Reading src/main.ts…"
        );
        assert_eq!(
            tool_status(&json!({ "toolName": "glob", "args": { "pattern": "src/**/*.tsx" } })),
            "Matching src/**/*.tsx…"
        );
        assert_eq!(
            tool_status(
                &json!({ "toolName": "bash", "args": { "command": "pnpm   test\n--run" } })
            ),
            "Running pnpm test --run…"
        );
    }

    #[test]
    fn rewrites_omp_missing_key_errors_to_settings_guidance() {
        let runtime = AgentRuntime::new(
            PathBuf::from("/tmp/missing-omp"),
            PathBuf::from("/tmp/missing-omp-assets"),
            std::env::temp_dir().join(format!("lattice-omp-auth-{}", uuid::Uuid::new_v4())),
        );
        fs::create_dir_all(&runtime.config).unwrap();
        fs::write(omp_auth_marker(&runtime, "claude"), "OMP\n").unwrap();
        let rewritten = rewrite_agent_auth_error(
            &runtime,
            "claude",
            "No API key found for anthropic.\n\nUse /login, set an API key environment variable, or create agent.db",
        );
        assert!(rewritten.starts_with(SUBSCRIPTION_AUTH_ERROR_PREFIX));
        assert!(rewritten.contains("Settings → Subscriptions"));
        assert!(!rewritten.contains("/login"));
        assert!(!omp_auth_marker(&runtime, "claude").is_file());
        assert!(
            rewrite_agent_auth_error(&runtime, "openai-api", "No API key found for openai.")
                .contains("Settings → API keys")
        );
        assert_eq!(
            rewrite_agent_auth_error(&runtime, "claude", "Model timed out."),
            "Model timed out."
        );
        fs::write(omp_auth_marker(&runtime, "claude"), "OMP\n").unwrap();
        assert_eq!(
            rewrite_agent_auth_error(
                &runtime,
                "claude",
                "Could not open agent.db because the database is locked."
            ),
            "Could not open agent.db because the database is locked."
        );
        assert!(omp_auth_marker(&runtime, "claude").is_file());
        fs::remove_dir_all(&runtime.config).unwrap();
    }

    #[test]
    fn subscription_guidance_points_at_settings() {
        assert!(subscription_sign_in_guidance("claude").starts_with(SUBSCRIPTION_AUTH_ERROR_PREFIX));
        assert!(subscription_sign_in_guidance("codex").contains("Settings → Subscriptions"));
        assert!(api_key_guidance("anthropic-api").starts_with(API_KEY_AUTH_ERROR_PREFIX));
    }

    #[test]
    fn preserves_omp_failures_during_subscription_status_checks() {
        let error = subscription_status_result(
            "claude",
            Err("The bundled OMP executable is missing.".to_string()),
        )
        .unwrap_err();
        assert!(error.contains("Could not check claude subscription status through OMP"));
        assert!(error.contains("bundled OMP executable is missing"));
        assert!(!error.contains(SUBSCRIPTION_AUTH_ERROR_PREFIX));
    }

    #[cfg(unix)]
    #[test]
    fn sends_abort_to_the_active_omp_process() {
        let runtime = AgentRuntime::new(
            PathBuf::from("/tmp/unused-omp"),
            PathBuf::from("/tmp/unused-assets"),
            std::env::temp_dir(),
        );
        let mut process = JsonLineProcess::spawn(Command::new("/bin/cat"), "test agent").unwrap();
        let registration = runtime
            .register_run(
                "test-session",
                process.stdin_handle(),
                process.id(),
                process.lifecycle_handle(),
            )
            .unwrap();

        assert!(runtime.abort_run("test-session").unwrap());
        assert!(registration.was_cancelled());
        let command = process.next_value().unwrap().unwrap();
        assert_eq!(command.get("type").and_then(Value::as_str), Some("abort"));

        process.finish(true).unwrap();
        drop(registration);
        assert!(!runtime.abort_run("test-session").unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn force_stops_an_unresponsive_agent_after_the_grace_period() {
        let runtime = AgentRuntime::new(
            PathBuf::from("/tmp/unused-omp"),
            PathBuf::from("/tmp/unused-assets"),
            std::env::temp_dir(),
        );
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "trap '' TERM; sleep 30"]);
        let mut process = JsonLineProcess::spawn(command, "unresponsive agent").unwrap();
        let registration = runtime
            .register_run(
                "unresponsive-session",
                process.stdin_handle(),
                process.id(),
                process.lifecycle_handle(),
            )
            .unwrap();
        let started = Instant::now();

        assert!(runtime.abort_run("unresponsive-session").unwrap());
        let (status, _) = process.finish(false).unwrap();

        assert!(!status.success());
        assert!(registration.was_cancelled());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn preserves_cancellation_when_omp_is_already_closing() {
        let runtime = AgentRuntime::new(
            PathBuf::from("/tmp/unused-omp"),
            PathBuf::from("/tmp/unused-assets"),
            std::env::temp_dir(),
        );
        let process_lifecycle = Arc::new(ProcessLifecycle::new());
        let registration = runtime
            .register_run(
                "closing-session",
                Weak::new(),
                u32::MAX,
                Arc::clone(&process_lifecycle),
            )
            .unwrap();

        assert!(runtime.abort_run("closing-session").unwrap());
        assert!(registration.was_cancelled());
        let error = registration
            .result_or_cancelled::<()>(Err(
                "Lattice agent stopped before responding to get_state.".to_string()
            ))
            .unwrap_err();
        assert!(error.starts_with(AGENT_STOPPED_ERROR_PREFIX));
        process_lifecycle.mark_exited();
    }

    #[test]
    fn persists_an_omp_session_reference_inside_the_project() {
        let root =
            std::env::temp_dir().join(format!("lattice-omp-session-{}", uuid::Uuid::new_v4()));
        let session_dir = root.join(".research/omp-sessions");
        fs::create_dir_all(&session_dir).unwrap();
        let lattice_id = uuid::Uuid::new_v4().to_string();
        let omp_id = uuid::Uuid::new_v4().to_string();
        let file_name = format!("2026-07-18_{omp_id}.jsonl");
        let session_file = session_dir.join(&file_name);
        fs::write(&session_file, "{}\n").unwrap();
        let state = json!({
            "data": { "sessionId": omp_id, "sessionFile": session_file }
        });
        persist_session_from_state(&root, &lattice_id, &state).unwrap();
        assert_eq!(
            omp_session_file(&root, &lattice_id).unwrap(),
            Some(session_file)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copies_a_legacy_pi_conversation_before_omp_resumes_it() {
        let root =
            std::env::temp_dir().join(format!("lattice-omp-migration-{}", uuid::Uuid::new_v4()));
        let session_id = uuid::Uuid::new_v4().to_string();
        let legacy_dir = root.join(".research/pi-sessions");
        fs::create_dir_all(&legacy_dir).unwrap();
        let file_name = format!("2026-07-18T12-00-00_{session_id}.jsonl");
        fs::write(
            legacy_dir.join(&file_name),
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"{session_id}\",\"timestamp\":\"2026-07-18T12:00:00Z\",\"cwd\":\"{}\"}}\n{{\"type\":\"message\",\"id\":\"message-1\",\"parentId\":null,\"timestamp\":\"2026-07-18T12:00:01Z\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"Hello\\n\\n<lattice_editor_context><active_file>main.tex</active_file></lattice_editor_context>\"}}]}}}}\n",
                root.display()
            ),
        )
        .unwrap();
        let migrated = omp_session_file(&root, &session_id).unwrap().unwrap();
        assert_eq!(
            migrated,
            root.join(".research/omp-sessions").join(file_name)
        );
        assert!(migrated.is_file());
        let migrated_content = fs::read_to_string(migrated).unwrap();
        assert!(migrated_content.contains("Hello"));
        assert!(!migrated_content.contains("lattice_editor_context"));
        assert!(legacy_dir.is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "uses the local Codex subscription and bundled OMP sidecar"]
    fn omp_edits_a_project_and_records_the_change() {
        let parent = std::env::temp_dir().join(format!("lattice-omp-e2e-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&parent).unwrap();
        let root = project::create(&parent, "paper").unwrap();
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let runtime = AgentRuntime::new(
            manifest
                .join("binaries")
                .join("lattice-agent-aarch64-apple-darwin"),
            manifest.join("omp-assets"),
            parent.join("omp-config"),
        );
        let settings = AgentSettings {
            provider: "codex".to_string(),
            model: "gpt-5.6-sol".to_string(),
            reasoning_effort: "low".to_string(),
        };
        let session_id = uuid::Uuid::new_v4().to_string();
        let message_id = uuid::Uuid::new_v4().to_string();
        project::save_conversation_checkpoint(&root, &session_id, &message_id).unwrap();
        let result = run(
            &root,
            &runtime,
            AgentRequest {
                settings: &settings,
                message: "Edit main.tex and replace 'Motivate the problem and state the paper's main contribution.' with 'State the research problem and central hypothesis clearly.' Then briefly report what you changed.",
                attachments: &[],
                active_file: Some("main.tex"),
                selection: None,
                session_id: &session_id,
                session_title: "E2E",
                system_prompt: "",
            },
            &|_| {},
        )
        .unwrap();
        assert!(result.changed_files.contains(&"main.tex".to_string()));
        assert!(fs::read_to_string(root.join("main.tex"))
            .unwrap()
            .contains("State the research problem and central hypothesis clearly."));
        assert!(result.transaction_id.is_some());
        let branch = fork_session(&root, &runtime, &settings, &session_id, "E2E", 0, "").unwrap();
        assert_ne!(branch.session_id, session_id);
        assert!(branch.source_timestamp.is_some());
        project::restore_conversation_checkpoint(
            &root,
            &session_id,
            &message_id,
            branch.source_timestamp.as_deref(),
        )
        .unwrap();
        assert!(fs::read_to_string(root.join("main.tex"))
            .unwrap()
            .contains("Motivate the problem and state the paper's main contribution."));
        assert!(root
            .join(".research/omp-session-map")
            .join(format!("{session_id}.json"))
            .is_file());
        fs::remove_dir_all(parent).unwrap();
    }
}
