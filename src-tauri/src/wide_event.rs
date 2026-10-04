//! One wide, structured log event per operation.
//!
//! An operation — a compile, an Overleaf sync, a sidecar start — is a
//! `tracing` span opened by [`Operation::start`]. Code running inside it, at
//! any depth and across the blocking pool (`ipc::run_quietly` carries the
//! span over), adds fields to that one span with [`record`] and [`add`], and
//! a [`step`] adds its own duration. When the span closes, [`WideEvents`]
//! writes a single JSON line through the `log` facade, so tauri-plugin-log's
//! file and console targets carry it like every other line:
//!
//! `[…][lattice::event][INFO] {"event":"latex.compile","outcome":"success","duration_ms":2310,…}`
//!
//! A failed operation adds `error_kind` (stable, for grouping), `error_cause`
//! (the error's first line) and `error_fix` (what the user can do about it).
//!
//! Fields are counts, sizes, flags and project-relative paths, never document
//! text. As a backstop every string is scrubbed when the event is written: the
//! project root and the home directory are cut from paths, and credentials,
//! cookies and one-time codes are masked.
//!
//! Plain `tracing` events, from Lattice or a dependency, are forwarded to
//! `log` as ordinary lines, so the log plugin remains the only sink and its
//! level filter the only filter.

use regex::Regex;
use serde_json::{Map, Value};
use std::fmt::Write as _;
use std::future::Future;
use std::path::Path;
use std::sync::{Arc, LazyLock};
use std::time::Instant;
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id};
use tracing::{Event, Instrument, Metadata, Span, Subscriber};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::prelude::*;
use tracing_subscriber::registry::{LookupSpan, Registry};

/// The `log` target every wide event is written under.
pub const TARGET: &str = "lattice::event";
/// The `tracing` target of operation and step spans. Spans under any other
/// target are not tracked: dependencies' spans would only cost memory.
const SPAN_TARGET: &str = "lattice::op";
/// An error cause is one line; LaTeX logs and server bodies stay out.
const MAX_CAUSE_CHARS: usize = 240;
const MAX_STRING_CHARS: usize = 400;

/// What went wrong, in terms that stay stable across error wordings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Failure {
    /// A short snake_case id to group failures by.
    pub kind: &'static str,
    /// What the user (or whoever reads the report) can do about it.
    pub fix: &'static str,
}

/// Maps an operation's error message to its [`Failure`].
pub type Classify = fn(&str) -> Failure;

/// Install the subscriber that turns operation spans into wide events and
/// forwards every other `tracing` event to `log`. Call once, at startup.
pub fn init() {
    let home = std::env::var("HOME").ok();
    let subscriber = tracing_subscriber::registry().with(WideEvents::new(Arc::new(LogSink), home));
    // Only fails when a subscriber is already installed, which leaves that one in charge.
    let _ = tracing::subscriber::set_global_default(subscriber);
}

/// One operation's span. Dropping it without [`Operation::finish`] — an
/// early return, a cancelled future — still writes the event, with the
/// outcome `abandoned`.
pub struct Operation {
    span: Span,
    classify: Classify,
}

impl Operation {
    pub fn start(event: &'static str, classify: Classify) -> Self {
        Self { span: tracing::info_span!(target: SPAN_TARGET, "operation", event), classify }
    }

    pub fn record(&self, key: &str, value: impl Into<Value>) {
        let value = value.into();
        with_fields(&self.span, |fields| {
            fields.values.insert(key.into(), value);
        });
    }

    /// Record how the operation ended, then close it.
    pub fn finish<T>(self, result: &Result<T, String>) {
        match result {
            Ok(_) => with_fields(&self.span, |fields| {
                fields.outcome.get_or_insert("success");
            }),
            Err(error) => {
                let failure = (self.classify)(error);
                with_fields(&self.span, |fields| fields.fail(failure, error));
            }
        }
    }

    /// Run `work` inside the operation and finish it with the result.
    pub async fn run<T>(self, work: impl Future<Output = Result<T, String>>) -> Result<T, String> {
        let result = work.instrument(self.span.clone()).await;
        self.finish(&result);
        result
    }

    /// [`Operation::run`] for synchronous work.
    pub fn run_sync<T>(self, work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let result = self.span.in_scope(work);
        self.finish(&result);
        result
    }

    /// [`Operation::run_sync`], except that the event is not written when
    /// `unlogged` says the result is not worth one, such as a failure that
    /// repeats on every keystroke.
    pub fn run_sync_unless<T>(
        self, work: impl FnOnce() -> Result<T, String>,
        unlogged: impl FnOnce(&Result<T, String>) -> bool,
    ) -> Result<T, String> {
        let result = self.span.in_scope(work);
        if unlogged(&result) {
            self.discard();
        } else {
            self.finish(&result);
        }
        result
    }

    /// Close the operation without writing its event, for one that turned
    /// out never to have happened.
    pub fn discard(self) {
        self.span.with_subscriber(|(id, dispatch)| {
            if let Some(span) = dispatch.downcast_ref::<Registry>().and_then(|r| r.span(id)) {
                span.extensions_mut().remove::<Fields>();
            }
        });
    }

    /// Close an operation that is not one call (a browser session): a
    /// success, or the failure and its cause.
    pub fn end(self, failure: Option<(Failure, &str)>) {
        with_fields(&self.span, |fields| match failure {
            Some((failure, cause)) => fields.fail(failure, cause),
            None => fields.outcome = Some("success"),
        });
    }
}

/// Add `key` to the operation the current span belongs to. Outside every
/// operation this does nothing, so domain code can record unconditionally.
pub fn record(key: &str, value: impl Into<Value>) {
    let value = value.into();
    with_fields(&Span::current(), |fields| {
        fields.values.insert(key.into(), value);
    });
}

/// Scope the current operation to the project at `root`: the root is cut
/// from every string its event writes, and the project appears only as a
/// short hash, enough to tell one project's events from another's.
pub fn project(root: &Path) {
    let root = root.to_string_lossy().trim_end_matches('/').to_string();
    with_fields(&Span::current(), |fields| {
        fields.values.insert("project".into(), project_id(&root).into());
        fields.root = Some(root);
    });
}

/// Add `amount` to a counter on the current operation (retries, bytes sent).
pub fn add(key: &str, amount: u64) {
    with_fields(&Span::current(), |fields| {
        let total = fields.values.get(key).and_then(Value::as_u64).unwrap_or(0);
        fields.values.insert(key.into(), (total + amount).into());
    });
}

/// Set the current operation's outcome when the work itself did not fail but
/// did not succeed either, such as a document with LaTeX errors or a
/// cancelled build.
pub fn outcome(outcome: &'static str) {
    with_fields(&Span::current(), |fields| fields.outcome = Some(outcome));
}

/// A timed step of the current operation: while the returned guard lives,
/// the step runs; when it drops, `<name>_ms` is added to the operation.
pub fn step(name: &'static str) -> tracing::span::EnteredSpan {
    tracing::info_span!(target: SPAN_TARGET, "step", step = name).entered()
}

/// A short, stable id for a project root: correlation without the path.
fn project_id(root: &str) -> String {
    crate::util::sha256_hex(root)[..10].to_string()
}

/// Run `apply` on the fields of the operation enclosing `span`, if any.
fn with_fields(span: &Span, apply: impl FnOnce(&mut Fields)) {
    let mut apply = Some(apply);
    span.with_subscriber(|(id, dispatch)| {
        let Some(registry) = dispatch.downcast_ref::<Registry>() else {
            return;
        };
        let Some(span) = registry.span(id) else {
            return;
        };
        for span in span.scope() {
            if let Some(fields) = span.extensions_mut().get_mut::<Fields>() {
                if let Some(apply) = apply.take() {
                    apply(fields);
                }
                return;
            }
        }
    });
}

/// What an open operation has collected so far.
struct Fields {
    event: String,
    started: Instant,
    outcome: Option<&'static str>,
    root: Option<String>,
    values: Map<String, Value>,
}

impl Fields {
    fn fail(&mut self, failure: Failure, cause: &str) {
        self.outcome = Some("error");
        self.values.insert("error_kind".into(), failure.kind.into());
        let first_line = cause.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("");
        let cause = crate::util::truncate_chars(first_line, MAX_CAUSE_CHARS);
        self.values.insert("error_cause".into(), cause.into());
        self.values.insert("error_fix".into(), failure.fix.into());
    }

    /// The event's single JSON line, every string scrubbed.
    fn line(self, home: Option<&str>) -> (log::Level, String) {
        let outcome = self.outcome.unwrap_or("abandoned");
        let duration_ms = self.started.elapsed().as_millis() as u64;
        let mut line = format!(
            r#"{{"event":{},"outcome":"{outcome}","duration_ms":{duration_ms}"#,
            Value::from(self.event)
        );
        for (key, value) in self.values {
            let value = match value {
                Value::String(text) => Value::String(scrub(&text, self.root.as_deref(), home)),
                other => other,
            };
            let _ = write!(line, ",{}:{value}", Value::from(scrub(&key, None, None)));
        }
        line.push('}');
        let level = if outcome == "error" { log::Level::Warn } else { log::Level::Info };
        (level, line)
    }
}

/// A timed step inside an operation.
struct Step {
    name: String,
    started: Instant,
}

static SECRETS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        // Authorization headers and bearer tokens.
        (r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}", "$1 [redacted]"),
        // A whole cookie header, and Overleaf's session cookies wherever they appear.
        (r"(?i)\b((?:set-)?cookie\s*[:=]\s*)[^\r\n]+", "$1[redacted]"),
        (r"(?i)\b(overleaf_session2|sharelatex\.sid|_csrf|csrf[_-]?token)(\s*[:=]\s*)[^\s;&,]+", "$1$2[redacted]"),
        // Keyed secrets: tokens, keys, passwords, nonces and session ids, as
        // `key=value`, `key: value` or JSON.
        (
            r#"(?i)\b([a-z0-9_-]*(?:token|api[_-]?key|secret|password|passwd|nonce|otp|ticket|session[_-]?id)["']?\s*[:=]\s*["']?)[^\s"'&,;}]+"#,
            "$1[redacted]",
        ),
        // One-time codes, but not every `code`: an exit code is a diagnosis.
        (
            r#"(?i)((?:\b(?:one[_-]?time|verification|login|auth|otp)[ _-]?code|[?&]code)["']?\s*[:=]\s*["']?)[^\s"'&,;}]+"#,
            "$1[redacted]",
        ),
        // Credentials in a URL.
        (r"(?i)(https?://)[^\s/@:]+:[^\s/@]+@", "$1[redacted]@"),
    ]
    .into_iter()
    .map(|(pattern, replacement)| (Regex::new(pattern).expect("valid redaction pattern"), replacement))
    .collect()
});

/// `text` with `root` and `home` cut from paths and secrets masked.
pub(crate) fn scrub(text: &str, root: Option<&str>, home: Option<&str>) -> String {
    let mut text = text.to_string();
    if let Some(root) = root.filter(|root| root.len() > 1) {
        text = text.replace(&format!("{root}/"), "").replace(root, ".");
    }
    if let Some(home) = home.filter(|home| home.len() > 1) {
        text = text.replace(home, "~");
    }
    for (pattern, replacement) in SECRETS.iter() {
        if let std::borrow::Cow::Owned(masked) = pattern.replace_all(&text, *replacement) {
            text = masked;
        }
    }
    crate::util::truncate_chars(&text, MAX_STRING_CHARS)
}

/// Where finished lines go: the `log` facade in the app, a buffer in tests.
pub trait Sink: Send + Sync + 'static {
    fn enabled(&self, level: log::Level, target: &str) -> bool;
    fn write(&self, level: log::Level, target: &str, message: &str);
}

struct LogSink;

impl Sink for LogSink {
    fn enabled(&self, level: log::Level, target: &str) -> bool {
        log::logger().enabled(&log::Metadata::builder().level(level).target(target).build())
    }

    fn write(&self, level: log::Level, target: &str, message: &str) {
        log::logger().log(
            &log::Record::builder()
                .level(level)
                .target(target)
                .args(format_args!("{message}"))
                .build(),
        );
    }
}

/// The `tracing` layer behind [`init`].
pub struct WideEvents {
    sink: Arc<dyn Sink>,
    home: Option<String>,
}

impl WideEvents {
    pub fn new(sink: Arc<dyn Sink>, home: Option<String>) -> Self {
        let home = home.map(|home| home.trim_end_matches('/').to_string());
        Self { sink, home: home.filter(|home| !home.is_empty()) }
    }
}

fn log_level(level: &tracing::Level) -> log::Level {
    match *level {
        tracing::Level::ERROR => log::Level::Error,
        tracing::Level::WARN => log::Level::Warn,
        tracing::Level::INFO => log::Level::Info,
        tracing::Level::DEBUG => log::Level::Debug,
        tracing::Level::TRACE => log::Level::Trace,
    }
}

impl<S> Layer<S> for WideEvents
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
{
    fn register_callsite(
        &self, metadata: &'static Metadata<'static>,
    ) -> tracing::subscriber::Interest {
        if metadata.is_span() && metadata.target() != SPAN_TARGET {
            return tracing::subscriber::Interest::never();
        }
        // The log plugin installs its level after early callsites register,
        // so event interest is decided per event, not cached.
        tracing::subscriber::Interest::sometimes()
    }

    fn enabled(&self, metadata: &Metadata<'_>, _: Context<'_, S>) -> bool {
        if metadata.is_span() {
            return metadata.target() == SPAN_TARGET;
        }
        self.sink.enabled(log_level(metadata.level()), metadata.target())
    }

    fn on_new_span(&self, attributes: &Attributes<'_>, id: &Id, context: Context<'_, S>) {
        let Some(span) = context.span(id) else {
            return;
        };
        let mut values = Map::new();
        attributes.record(&mut FieldVisitor(&mut values));
        let name = |key: &str| values.get(key).and_then(Value::as_str).unwrap_or("").to_string();
        let mut extensions = span.extensions_mut();
        match attributes.metadata().name() {
            "operation" => extensions.insert(Fields {
                event: name("event"),
                started: Instant::now(),
                outcome: None,
                root: None,
                values: Map::new(),
            }),
            "step" => extensions.insert(Step { name: name("step"), started: Instant::now() }),
            _ => {}
        }
    }

    fn on_event(&self, event: &Event<'_>, _: Context<'_, S>) {
        let metadata = event.metadata();
        let mut values = Map::new();
        event.record(&mut FieldVisitor(&mut values));
        let mut message = match values.remove("message") {
            Some(Value::String(message)) => message,
            Some(other) => other.to_string(),
            None => String::new(),
        };
        for (key, value) in values {
            let _ = write!(message, " {key}={value}");
        }
        self.sink.write(log_level(metadata.level()), metadata.target(), message.trim_start());
    }

    fn on_close(&self, id: Id, context: Context<'_, S>) {
        let Some(span) = context.span(&id) else {
            return;
        };
        let step = span.extensions_mut().remove::<Step>();
        if let Some(step) = step {
            let key = format!("{}_ms", step.name);
            let elapsed = step.started.elapsed().as_millis() as u64;
            for ancestor in span.scope().skip(1) {
                if let Some(fields) = ancestor.extensions_mut().get_mut::<Fields>() {
                    let total = fields.values.get(&key).and_then(Value::as_u64).unwrap_or(0);
                    fields.values.insert(key, (total + elapsed).into());
                    break;
                }
            }
            return;
        }
        let fields = span.extensions_mut().remove::<Fields>();
        if let Some(fields) = fields {
            let (level, line) = fields.line(self.home.as_deref());
            if self.sink.enabled(level, TARGET) {
                self.sink.write(level, TARGET, &line);
            }
        }
    }
}

struct FieldVisitor<'a>(&'a mut Map<String, Value>);

impl Visit for FieldVisitor<'_> {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.insert(field.name().into(), value.into());
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.0.insert(field.name().into(), value.into());
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.0.insert(field.name().into(), value.into());
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.0.insert(field.name().into(), value.into());
    }
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.0.insert(field.name().into(), format!("{value:?}").into());
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    pub(crate) struct Capture(Mutex<Vec<(log::Level, String, String)>>);

    impl Sink for Capture {
        fn enabled(&self, _: log::Level, _: &str) -> bool {
            true
        }
        fn write(&self, level: log::Level, target: &str, message: &str) {
            self.0.lock().unwrap().push((level, target.to_string(), message.to_string()));
        }
    }

    impl Capture {
        /// The wide events written so far, parsed.
        pub(crate) fn events(&self) -> Vec<Value> {
            let lines = self.0.lock().unwrap();
            (lines.iter())
                .filter(|(_, target, _)| target == TARGET)
                .map(|(_, _, line)| {
                    serde_json::from_str(line).expect("an event is one JSON object")
                })
                .collect()
        }
    }

    /// Run `work` with wide events captured instead of logged.
    pub(crate) fn capture<T>(work: impl FnOnce() -> T) -> (T, Arc<Capture>) {
        // A callsite's interest is cached when some thread first reaches it.
        // With a single dispatcher registered, tracing asks only that
        // thread's default — empty on another test's thread — and caches
        // "never" for everyone. A second, permanent dispatcher makes it ask
        // every registered one, this test's included.
        static SECOND: LazyLock<tracing::Dispatch> =
            LazyLock::new(|| tracing::Dispatch::new(tracing::subscriber::NoSubscriber::default()));
        LazyLock::force(&SECOND);
        let capture = Arc::new(Capture::default());
        let sink = Arc::clone(&capture) as Arc<dyn Sink>;
        let layer = WideEvents::new(sink, Some(format!("{HOME}/")));
        let subscriber = tracing_subscriber::registry().with(layer);
        (tracing::subscriber::with_default(subscriber, work), capture)
    }

    pub(crate) const HOME: &str = "/Users/alice";

    fn failing(_: &str) -> Failure {
        Failure { kind: "test_failure", fix: "Do the other thing." }
    }

    #[test]
    fn nested_steps_and_records_land_on_one_event() {
        let (_, capture) = capture(|| {
            let operation = Operation::start("test.op", failing);
            operation.record("files", 3_u64);
            let result: Result<(), String> = operation.run_sync(|| {
                let _step = step("download");
                record("bytes", 1024_u64);
                add("retries", 1);
                add("retries", 2);
                tracing::info!(target: "lattice::test", count = 2, "an ordinary line");
                Ok(())
            });
            assert!(result.is_ok());
        });
        let events = capture.events();
        assert_eq!(events.len(), 1, "{events:?}");
        let event = &events[0];
        assert_eq!(event["event"], "test.op");
        assert_eq!(event["outcome"], "success");
        assert!(event["duration_ms"].is_u64());
        assert!(event["download_ms"].is_u64());
        assert_eq!(event["files"], 3);
        assert_eq!(event["bytes"], 1024);
        assert_eq!(event["retries"], 3);
        let lines = capture.0.lock().unwrap();
        assert!(lines.iter().any(|(level, target, message)| *level == log::Level::Info
            && target == "lattice::test"
            && message == "an ordinary line count=2"));
    }

    #[test]
    fn a_failure_says_why_and_what_to_do() {
        let (_, capture) = capture(|| {
            let result: Result<(), String> = Operation::start("test.op", failing)
                .run_sync(|| Err("It broke.\nl.12 the whole document text".into()));
            assert!(result.is_err());
            // Dropped without finishing: still one event, marked as such.
            drop(Operation::start("test.dropped", failing));
        });
        let events = capture.events();
        assert_eq!(events[0]["outcome"], "error");
        assert_eq!(events[0]["error_kind"], "test_failure");
        assert_eq!(events[0]["error_cause"], "It broke.");
        assert_eq!(events[0]["error_fix"], "Do the other thing.");
        assert_eq!(events[1]["outcome"], "abandoned");
        let lines = capture.0.lock().unwrap();
        assert_eq!(lines.iter().filter(|(level, ..)| *level == log::Level::Warn).count(), 1);
    }

    #[test]
    fn an_unlogged_result_writes_no_event() {
        let (_, capture) = capture(|| {
            let quiet = Operation::start("test.quiet", failing)
                .run_sync_unless(|| Err::<(), _>("again".to_string()), |_| true);
            assert!(quiet.is_err());
            let logged = Operation::start("test.logged", failing)
                .run_sync_unless(|| Ok::<_, String>(()), |result| result.is_err());
            assert!(logged.is_ok());
        });
        let events = capture.events();
        assert_eq!(events.len(), 1, "{events:?}");
        assert_eq!(events[0]["event"], "test.logged");
        assert_eq!(events[0]["outcome"], "success");
    }

    #[test]
    fn work_another_thread_runs_in_the_span_records_onto_its_operation() {
        let (_, capture) = capture(|| {
            let operation = Operation::start("test.threads", failing);
            // What `ipc::run_quietly` does for the blocking pool. In the app the
            // dispatcher is global; here it is this thread's, so pass it along.
            let span = operation.span.clone();
            let dispatch = tracing::dispatcher::get_default(Clone::clone);
            std::thread::spawn(move || {
                tracing::dispatcher::with_default(&dispatch, || {
                    span.in_scope(|| record("from_thread", true))
                })
            })
            .join()
            .unwrap();
            operation.finish(&Ok::<_, String>(()));
        });
        assert_eq!(capture.events()[0]["from_thread"], true);
    }

    #[test]
    fn redaction_holds_for_every_written_string() {
        let home = HOME;
        let root = format!("{home}/Papers/My Thesis");
        let (_, capture) = capture(|| {
            let operation = Operation::start("test.private", failing);
            operation.span.in_scope(|| project(Path::new(&root)));
            operation.record("path", format!("{root}/chapters/intro.tex"));
            operation.record("elsewhere", format!("{home}/Library/Caches/thing.log"));
            operation.record("header", "Cookie: overleaf_session2=s%3Acookie-secret; other=1");
            operation.record("bare_cookie", "sent overleaf_session2=s%3Abare-secret to the host");
            operation.record("auth", "Authorization: Bearer abcdefgh-bearer-secret");
            operation.record("url", "http://127.0.0.1:4100/?token=url-secret&nonce=nonce-secret");
            operation.record("json", r#"{"api_key":"json-secret","one_time_code":"123456"}"#);
            operation.record("login", "verification code: 987654 sent");
            operation.record("proxy", "https://user:proxy-secret@proxy.example:8080");
            let _ = operation.run_sync(|| {
                Err::<(), _>(format!("Could not read {root}/main.tex: token=cause-secret"))
            });
        });
        let events = capture.events();
        let line = events[0].to_string();
        for leaked in ["secret", "123456", "987654", "My Thesis", "/Users/", "alice"] {
            assert!(!line.contains(leaked), "leaked {leaked:?}: {line}");
        }
        let event = &events[0];
        assert_eq!(event["path"], "chapters/intro.tex");
        assert_eq!(event["elsewhere"], "~/Library/Caches/thing.log");
        assert_eq!(event["error_cause"], "Could not read main.tex: token=[redacted]");
        assert_eq!(event["project"].as_str().map(str::len), Some(10));
        // Ordinary words that merely contain a key name survive, as do exit codes.
        for kept in ["encoded tokens: 4 sessions", "latexmk failed with exit code: 12"] {
            assert_eq!(scrub(kept, None, None), kept);
        }
    }
}
