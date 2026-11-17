//! One `flashtex-host` per project, working in a copy of it.

use super::install::{installed_host, unicode_host};
use super::protocol::{
    read_frame, write_frame, CLIENT_HELLO, COMPILE, DIAGNOSTIC, DONE, ERROR, HOST_HELLO, VERSION,
};
use super::{home, mirror};
use crate::commands::{in_new_process_group, with_child_path};
use crate::latex::aux_files::{in_layout, AuxFiles};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, Read};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime};

static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

/// How long the host may take to come up: the first start builds its
/// pdfLaTeX format from the user's TeX Live, about 4 s.
const START_TIMEOUT: Duration = Duration::from_secs(120);
/// How long one compile may take. A cold compile of a long document with its
/// convergence passes takes a few seconds; anything far past that is a hang.
const COMPILE_TIMEOUT: Duration = Duration::from_secs(180);

/// The TeX engine a project builds with, as the window names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Pdflatex,
    Xelatex,
}

impl Engine {
    /// The format FlashTeX loads, and the host that has it.
    fn format(self) -> &'static str {
        match self {
            Self::Pdflatex => "pdflatex",
            Self::Xelatex => "xelatex",
        }
    }

    fn host(self) -> Result<PathBuf, String> {
        match self {
            Self::Pdflatex => {
                installed_host().ok_or_else(|| "FlashTeX is not installed.".to_string())
            }
            Self::Xelatex => {
                unicode_host().ok_or_else(|| "No FlashTeX XeTeX host is configured.".to_string())
            }
        }
    }
}

/// A file as the editor has it: `path` relative to the project.
#[derive(Debug, Deserialize)]
pub struct Buffer {
    path: String,
    text: String,
}

/// What one compile did, from the host's `DONE` frame.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileReport {
    /// `ok`, `error` (TeX reported errors; the pages that shipped are valid),
    /// `cancelled` or `failed` (the engine died).
    pub status: String,
    /// `cold`, `incremental` or `unchanged`.
    pub mode: String,
    pub pages: u64,
    /// Pages this compile typeset.
    pub typeset_pages: u64,
    /// The host's own time for the compile.
    pub host_ms: f64,
    /// From sending the compile to its `DONE`.
    pub wall_ms: f64,
    /// The first few TeX errors, for the developer reading the console.
    pub errors: Vec<String>,
    /// A PDF is there to read (`SessionHandle::pdf`).
    pub pdf: bool,
}

/// The socket and what the compiles share; one compile at a time.
struct Connection {
    stream: UnixStream,
    next_compile: u64,
    project: PathBuf,
    mirror: PathBuf,
    /// The main document relative to the project, and the folder it is in:
    /// TeX runs there, as latexmk's `-cd` runs it.
    main: PathBuf,
    main_folder: PathBuf,
    engine: Engine,
    output: PathBuf,
    pdf: Option<PathBuf>,
    /// The latexmk `.bbl` last copied into `output`, by modification time and size.
    bibliography: Option<(SystemTime, u64)>,
}

/// The calls a window makes on a running session. Cheap to clone, so a
/// compile runs without holding the project's slot.
#[derive(Clone)]
pub struct SessionHandle(Arc<Mutex<Connection>>);

/// A running `flashtex-host` for one project.
pub struct Session {
    id: u64,
    child: Option<Child>,
    handle: SessionHandle,
    /// The socket, to end a compile that is waiting on it without its lock.
    stream: UnixStream,
    socket_dir: PathBuf,
    work_dir: PathBuf,
}

impl Session {
    /// Copy `root` and start the host on `main_file` (relative to `root`).
    /// Returns once the host has answered the protocol's `HELLO`.
    pub fn start(root: &Path, main_file: &str, engine: Engine) -> Result<Self, String> {
        Self::start_host(&engine.host()?, root, main_file, engine)
    }

    fn start_host(
        host: &Path, root: &Path, main_file: &str, engine: Engine,
    ) -> Result<Self, String> {
        let main = safe_relative(main_file)
            .filter(|main| root.join(main).is_file())
            .ok_or_else(|| format!("The main file {main_file:?} is not in the project."))?;
        let id = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
        let key = crate::util::sha256_hex(root.join(&main).to_string_lossy().as_bytes());
        let sessions =
            home().ok_or("Could not locate the FlashTeX preview folder.")?.join("sessions");
        // A session that stopped without cleaning up (Lattice was killed)
        // left its copy behind: clones cost little, but not nothing.
        if let Ok(entries) = fs::read_dir(&sessions) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with(&key[..16]) {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
        let work_dir = sessions.join(format!("{}-{id}", &key[..16]));
        let mirror = work_dir.join("project");
        let output = work_dir.join("output");
        let started = Instant::now();
        mirror::copy_project(root, &mirror)?;
        let main_folder = main.parent().map(Path::to_path_buf).unwrap_or_default();
        prepare_output(&mirror.join(&main_folder), &output)?;
        seed_auxiliary_file(root, &main, &output);
        log::info!(
            target: "lattice::flashtex-preview",
            "Copied {} for FlashTeX in {} ms",
            root.display(),
            started.elapsed().as_millis()
        );

        // macOS caps a socket path at 104 bytes, which Application Support
        // can pass, so the socket gets a short private folder of its own.
        let socket_dir = std::env::temp_dir()
            .join(format!("lattice-ft-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]));
        fs::create_dir(&socket_dir)
            .map_err(|error| format!("Could not create the FlashTeX socket folder: {error}"))?;
        #[cfg(unix)]
        fs::set_permissions(&socket_dir, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not secure the FlashTeX socket folder: {error}"))?;
        let socket = socket_dir.join("host.sock");

        let mut command = with_child_path(Command::new(host));
        command
            .arg("--socket")
            .arg(&socket)
            .args(["--once", "--accept-timeout", "60", "--no-warm", "--format", engine.format()])
            .current_dir(&work_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = in_new_process_group(&mut command)
            .spawn()
            .map_err(|error| format!("Could not start FlashTeX: {error}"))?;
        let tail = Arc::new(Mutex::new(OutputTail::default()));
        for output in [
            child.stdout.take().map(|out| Box::new(out) as Box<dyn Read + Send>),
            child.stderr.take().map(|err| Box::new(err) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let tail = Arc::clone(&tail);
            std::thread::spawn(move || read_output(output, &tail));
        }
        let connected = connect(&socket, &mut child, &tail).and_then(|stream| {
            hello(&stream)?;
            Ok(stream)
        });
        let stream = match connected {
            Ok(stream) => stream,
            Err(error) => {
                crate::sidecar::terminate_process_group(&mut child);
                let _ = fs::remove_dir_all(&socket_dir);
                let _ = fs::remove_dir_all(&work_dir);
                return Err(error);
            }
        };
        let shutdown = stream
            .try_clone()
            .map_err(|error| format!("Could not connect to FlashTeX: {error}"))?;
        log::info!(
            target: "lattice::flashtex-preview",
            "Started FlashTeX session {id} for {} ({})",
            root.display(),
            engine.format()
        );
        let connection = Connection {
            stream,
            next_compile: 1,
            project: root.to_path_buf(),
            mirror,
            main,
            main_folder,
            engine,
            output,
            pdf: None,
            bibliography: None,
        };
        Ok(Self {
            id,
            child: Some(child),
            handle: SessionHandle(Arc::new(Mutex::new(connection))),
            stream: shutdown,
            socket_dir,
            work_dir,
        })
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn handle(&self) -> SessionHandle {
        self.handle.clone()
    }

    /// End the host and delete the copy. Returns at once; a compile waiting
    /// on the host fails, and the wait for the process runs on its own thread.
    pub fn stop(mut self) {
        if let Some(finish) = self.shutdown() {
            std::thread::spawn(finish);
        }
    }

    /// [`Session::stop`], returning once the host is gone: before the app exits.
    pub fn stop_and_wait(mut self) {
        if let Some(finish) = self.shutdown() {
            finish();
        }
    }

    fn shutdown(&mut self) -> Option<impl FnOnce() + Send + 'static> {
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
        let mut child = self.child.take()?;
        let (id, socket_dir, work_dir) = (self.id, self.socket_dir.clone(), self.work_dir.clone());
        Some(move || {
            // `--once`: the host exits when its connection closes.
            let deadline = Instant::now() + Duration::from_secs(1);
            while Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            crate::sidecar::terminate_process_group(&mut child);
            let _ = fs::remove_dir_all(socket_dir);
            let _ = fs::remove_dir_all(work_dir);
            log::info!(target: "lattice::flashtex-preview", "Stopped FlashTeX session {id}");
        })
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(finish) = self.shutdown() {
            std::thread::spawn(finish);
        }
    }
}

impl SessionHandle {
    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Typeset the document with `buffers` in place of their files on disk.
    pub fn compile(&self, buffers: Vec<Buffer>) -> Result<CompileReport, String> {
        let mut connection = self.lock();
        connection.refresh_bibliography();
        let mut sent = Vec::new();
        for buffer in buffers {
            let relative = safe_relative(&buffer.path)
                .filter(|relative| !mirror::skipped(relative))
                .ok_or_else(|| format!("The file {:?} is not in the project.", buffer.path))?;
            match relative.strip_prefix(&connection.main_folder) {
                // The host writes it, and knows exactly what changed.
                Ok(inside) => sent.push(json!({ "path": slashed(inside), "text": buffer.text })),
                // The host takes only files under the folder it compiles in
                // (no `..`): one the document reaches outside it goes into
                // the copy here, and the host finds it changed when it reads it.
                Err(_) => {
                    let target = connection.mirror.join(&relative);
                    fs::write(&target, buffer.text).map_err(|error| {
                        format!("Could not copy {}: {error}", relative.display())
                    })?;
                }
            }
        }
        let id = connection.next_compile;
        connection.next_compile += 1;
        let main_name = connection.main.file_name().map(|name| name.to_string_lossy().into_owned());
        let request = json!({
            "id": id,
            "root": connection.mirror.join(&connection.main_folder),
            "main": main_name,
            "format": connection.engine.format(),
            "output_dir": connection.output,
            // A preview runs nothing but TeX: no `\write18`, and no BibTeX or
            // makeindex, whose results come from the last real build.
            "shell_escape": "off",
            "external_tools": "off",
            "incremental": true,
            "buffers": sent,
        });
        let started = Instant::now();
        let mut stream = &connection.stream;
        write_frame(&mut stream, COMPILE, &request)
            .map_err(|_| "FlashTeX has stopped.".to_string())?;
        let mut errors = Vec::new();
        loop {
            let (kind, frame) = read_frame(&mut stream, &[DIAGNOSTIC, DONE, ERROR])
                .map_err(|error| format!("FlashTeX stopped answering: {error}"))?;
            match kind {
                ERROR => {
                    return Err(format!("FlashTeX refused the compile: {}", frame_message(&frame)))
                }
                DIAGNOSTIC
                    if frame["id"] == id && frame["severity"] == "error" && errors.len() < 5 =>
                {
                    errors.push(frame_message(&frame));
                }
                DONE if frame["id"] == id => {
                    let wall_ms = started.elapsed().as_secs_f64() * 1000.0;
                    let pdf = frame["pdf"]
                        .as_str()
                        .map(PathBuf::from)
                        .filter(|pdf| pdf.starts_with(&connection.output) && pdf.is_file());
                    connection.pdf = pdf.clone().or(connection.pdf.take());
                    let count = |key: &str| frame[key].as_u64().unwrap_or(0);
                    return Ok(CompileReport {
                        status: frame["status"].as_str().unwrap_or("failed").to_string(),
                        mode: frame["mode"].as_str().unwrap_or_default().to_string(),
                        pages: count("pages"),
                        typeset_pages: count("typeset_pages"),
                        host_ms: frame["elapsed_ms"].as_f64().unwrap_or(0.0),
                        wall_ms,
                        errors,
                        pdf: pdf.is_some(),
                    });
                }
                _ => {}
            }
        }
    }

    /// The PDF of the last compile that wrote one.
    pub fn pdf(&self) -> Result<Vec<u8>, String> {
        let pdf = self.lock().pdf.clone().ok_or("FlashTeX has not written a PDF yet.")?;
        fs::read(&pdf).map_err(|error| format!("Could not read the FlashTeX PDF: {error}"))
    }

    /// Copy `paths` (relative to the project) into the copy again: they
    /// changed on disk, from a save, the agent or an Overleaf pull.
    pub fn sync(&self, paths: &[String]) -> Result<(), String> {
        let connection = self.lock();
        for path in paths {
            if let Some(relative) = safe_relative(path) {
                mirror::sync_file(&connection.project, &connection.mirror, &relative)?;
            }
        }
        Ok(())
    }
}

impl Connection {
    /// The bibliography comes from the last real build (the preview runs no
    /// BibTeX): copy its `.bbl` into the output folder whenever it changed.
    fn refresh_bibliography(&mut self) {
        let Some(source) = latexmk_file(&self.project, &self.main, "bbl") else { return };
        let Ok(metadata) = fs::metadata(&source) else { return };
        let stamp = (metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH), metadata.len());
        if self.bibliography == Some(stamp) {
            return;
        }
        let stem = self.main.file_stem().unwrap_or_default().to_string_lossy();
        if fs::copy(&source, self.output.join(format!("{stem}.bbl"))).is_ok() {
            self.bibliography = Some(stamp);
        }
    }
}

/// `document`'s intermediate file with `extension` from the last latexmk
/// build, in whichever layout it was built (see `aux_files`).
fn latexmk_file(root: &Path, document: &Path, extension: &str) -> Option<PathBuf> {
    let document = document.to_string_lossy();
    [AuxFiles::Hidden, AuxFiles::Beside]
        .into_iter()
        .map(|layout| in_layout(root, &document, extension, layout))
        .find(|path| path.is_file())
}

/// The output folder, with the folders under the document's that its
/// `\include`d files write their `.aux` into: pdfTeX cannot create them.
fn prepare_output(compile_root: &Path, output: &Path) -> Result<(), String> {
    fs::create_dir_all(output)
        .map_err(|error| format!("Could not create the FlashTeX output folder: {error}"))?;
    let mut pending = vec![PathBuf::new()];
    while let Some(relative) = pending.pop() {
        let Ok(entries) = fs::read_dir(compile_root.join(&relative)) else { continue };
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                let child = relative.join(entry.file_name());
                let _ = fs::create_dir_all(output.join(&child));
                pending.push(child);
            }
        }
    }
    Ok(())
}

/// Start from the last build's `.aux`, so the first compile's references and
/// page numbers are already right and it needs fewer passes to converge.
fn seed_auxiliary_file(root: &Path, main: &Path, output: &Path) {
    let stem = main.file_stem().unwrap_or_default().to_string_lossy();
    if let Some(aux) = latexmk_file(root, main, "aux") {
        let _ = fs::copy(aux, output.join(format!("{stem}.aux")));
    }
}

/// Wait for the host's socket, failing early if the host exits.
fn connect(
    socket: &Path, child: &mut Child, tail: &Mutex<OutputTail>,
) -> Result<UnixStream, String> {
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        if let Ok(stream) = UnixStream::connect(socket) {
            stream
                .set_read_timeout(Some(COMPILE_TIMEOUT))
                .and_then(|()| stream.set_write_timeout(Some(Duration::from_secs(10))))
                .map_err(|error| format!("Could not connect to FlashTeX: {error}"))?;
            return Ok(stream);
        }
        if let Ok(Some(status)) = child.try_wait() {
            // Give the output readers a moment to take the host's last words.
            std::thread::sleep(Duration::from_millis(100));
            let output = tail.lock().map(|tail| tail.text()).unwrap_or_default();
            return Err(format!("FlashTeX exited before it was ready ({status}): {output}"));
        }
        if Instant::now() > deadline {
            return Err("FlashTeX did not start in time.".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn hello(stream: &UnixStream) -> Result<(), String> {
    let mut stream = stream;
    let request = json!({ "protocol": "display-list-v3", "version": VERSION, "client": "Lattice" });
    write_frame(&mut stream, CLIENT_HELLO, &request)
        .map_err(|error| format!("Could not greet FlashTeX: {error}"))?;
    let (kind, answer) = read_frame(&mut stream, &[HOST_HELLO, ERROR])
        .map_err(|error| format!("FlashTeX did not answer: {error}"))?;
    if kind == ERROR {
        return Err(format!("FlashTeX refused the connection: {}", frame_message(&answer)));
    }
    if answer["version"][0] != VERSION[0] {
        return Err(format!("FlashTeX speaks protocol {}, not 3.", answer["version"]));
    }
    Ok(())
}

fn frame_message(frame: &Value) -> String {
    let message = frame["message"].as_str().unwrap_or("unknown error");
    match (frame["file"].as_str(), frame["line"].as_u64()) {
        (Some(file), Some(line)) => format!("{file}:{line}: {message}"),
        _ => message.to_string(),
    }
}

/// `path` with `/` between its parts, as the protocol names files.
fn slashed(path: &Path) -> String {
    path.components().map(|part| part.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
}

/// `path` when it is relative and stays inside the folder it is joined to.
fn safe_relative(path: &str) -> Option<PathBuf> {
    let path = Path::new(path);
    (!path.as_os_str().is_empty()
        && path.components().all(|part| matches!(part, Component::Normal(_))))
    .then(|| path.to_path_buf())
}

/// The last lines the host printed, for the error when it will not start.
#[derive(Default)]
struct OutputTail(VecDeque<String>);

impl OutputTail {
    const LINES: usize = 20;

    fn push(&mut self, line: String) {
        if self.0.len() == Self::LINES {
            self.0.pop_front();
        }
        self.0.push_back(line);
    }

    fn text(&self) -> String {
        self.0.iter().cloned().collect::<Vec<_>>().join("\n")
    }
}

fn read_output(output: impl Read, tail: &Mutex<OutputTail>) {
    for line in BufReader::new(output).lines() {
        let Ok(line) = line else { break };
        log::debug!(target: "lattice::flashtex-preview", "{line}");
        if let Ok(mut tail) = tail.lock() {
            tail.push(line);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn files_are_named_relative_and_inside_the_project() {
        assert_eq!(safe_relative("paper/main.tex"), Some(PathBuf::from("paper/main.tex")));
        for refused in ["", "/etc/passwd", "../x.tex", "a/../../x.tex", "./main.tex"] {
            assert_eq!(safe_relative(refused), None, "{refused}");
        }
        assert_eq!(slashed(Path::new("chapters/one.tex")), "chapters/one.tex");
    }

    #[test]
    fn the_engine_is_named_as_the_window_names_it() {
        let engine: Engine = serde_json::from_str("\"xelatex\"").unwrap();
        assert_eq!(engine.format(), "xelatex");
        assert!(serde_json::from_str::<Engine>("\"lualatex\"").is_err());
    }

    #[test]
    fn the_output_folder_has_the_documents_subfolders() {
        let project = TempDir::new("flashtex-output-project");
        project.write("chapters/one.tex", "one");
        project.write("chapters/parts/two.tex", "two");
        let output = project.join("out");
        prepare_output(&project, &output).unwrap();
        assert!(output.join("chapters/parts").is_dir());
    }

    /// One edit's trip through a real host, against the pinned release (set
    /// LATTICE_FLASHTEX_HOST_DIR to an unpacked `flashtex-cli` folder).
    #[test]
    #[ignore = "requires FlashTeX (set LATTICE_FLASHTEX_HOST_DIR) and TeX Live"]
    fn a_keystroke_reaches_the_pdf_without_touching_the_project() {
        let project = TempDir::new("flashtex-session");
        let saved = "\\documentclass{article}\\begin{document}Saved text.\\end{document}\n";
        project.write("main.tex", saved);
        let session = start_with_host(&project, "main.tex");
        let handle = session.handle();
        let first = handle.compile(Vec::new()).unwrap();
        assert_eq!(first.status, "ok", "{first:?}");
        assert!(first.pdf && handle.pdf().unwrap().starts_with(b"%PDF"));
        let unsaved = saved.replace("Saved", "Unsaved");
        let edit = handle.compile(vec![Buffer { path: "main.tex".into(), text: unsaved }]).unwrap();
        assert_eq!(edit.status, "ok", "{edit:?}");
        assert_ne!(edit.mode, "unchanged", "{edit:?}");
        assert_eq!(fs::read_to_string(project.join("main.tex")).unwrap(), saved);
        session.stop_and_wait();
    }

    /// The spike's measurement: type a word into each document of
    /// LATTICE_FLASHTEX_BENCH (a JSON list of `{name, dir, main, engine, host,
    /// file, needle, word}`) one character at a time, and write each compile's
    /// report, the final text and the last PDF under LATTICE_FLASHTEX_BENCH_OUT
    /// for comparing with latexmk's build of the same text.
    #[test]
    #[ignore = "measures real documents (set LATTICE_FLASHTEX_BENCH and LATTICE_FLASHTEX_BENCH_OUT)"]
    fn measure_typing_in_real_documents() {
        let config: Value = serde_json::from_str(
            &fs::read_to_string(std::env::var("LATTICE_FLASHTEX_BENCH").unwrap()).unwrap(),
        )
        .unwrap();
        let out = PathBuf::from(std::env::var("LATTICE_FLASHTEX_BENCH_OUT").unwrap());
        for paper in config.as_array().unwrap() {
            let text = |key: &str| paper[key].as_str().unwrap().to_string();
            let (dir, file) = (PathBuf::from(text("dir")), text("file"));
            let engine: Engine = serde_json::from_value(paper["engine"].clone()).unwrap();
            let results = out.join(text("name"));
            fs::create_dir_all(&results).unwrap();
            let mut log = Vec::new();
            let started = Instant::now();
            let session =
                Session::start_host(Path::new(&text("host")), &dir, &text("main"), engine).unwrap();
            log.push(
                json!({ "step": "start", "wall_ms": started.elapsed().as_secs_f64() * 1000.0 }),
            );
            let handle = session.handle();
            let mut previous: Option<Vec<String>> = None;
            let mut record = |step: String, buffers: Vec<Buffer>| {
                let report = handle.compile(buffers).unwrap();
                let read = Instant::now();
                let pdf = handle.pdf().unwrap_or_default();
                let read_ms = read.elapsed().as_secs_f64() * 1000.0;
                // The PDF panel signs every PDF it is handed, to redraw only
                // the pages that changed (pdf_pages.rs).
                let signing = Instant::now();
                let pages = crate::pdf_pages::signatures(&pdf).map(|signed| signed.pages).ok();
                let sign_ms = signing.elapsed().as_secs_f64() * 1000.0;
                let changed = match (&previous, &pages) {
                    (Some(before), Some(after)) if before.len() == after.len() => {
                        Some(before.iter().zip(after).filter(|(a, b)| a != b).count())
                    }
                    _ => None,
                };
                previous = pages;
                log.push(json!({
                    "step": step, "report": report, "pdf_read_ms": read_ms, "pdf_bytes": pdf.len(),
                    "sign_ms": sign_ms, "changed_pages": changed,
                }));
            };
            record("cold".into(), Vec::new());
            let original = fs::read_to_string(dir.join(&file)).unwrap();
            record("same text".into(), vec![Buffer { path: file.clone(), text: original.clone() }]);
            let at = original.find(&text("needle")).expect("needle");
            let word: Vec<char> = text("word").chars().collect();
            let mut typed = String::new();
            for character in &word {
                typed.push(*character);
                let edited = format!("{}{typed} {}", &original[..at], &original[at..]);
                record(format!("type {typed}"), vec![Buffer { path: file.clone(), text: edited }]);
            }
            let final_text = format!("{}{typed} {}", &original[..at], &original[at..]);
            fs::write(results.join("final.tex"), &final_text).unwrap();
            fs::write(results.join("flashtex.pdf"), handle.pdf().unwrap()).unwrap();
            fs::write(
                results.join("results.json"),
                serde_json::to_string_pretty(&Value::Array(log)).unwrap(),
            )
            .unwrap();
            session.stop_and_wait();
        }
    }

    fn start_with_host(project: &Path, main: &str) -> Session {
        let dir = PathBuf::from(
            std::env::var("LATTICE_FLASHTEX_HOST_DIR").expect("LATTICE_FLASHTEX_HOST_DIR"),
        );
        Session::start_host(&dir.join("bin/flashtex-host"), project, main, Engine::Pdflatex)
            .unwrap()
    }
}
