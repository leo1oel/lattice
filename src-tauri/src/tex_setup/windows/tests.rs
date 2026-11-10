// @ratchet-files-ignore: one scratch machine and every flow test that shares it.
//! The Windows install flow against a scratch machine: stand-in programs
//! (this test binary, re-run through a batch file so any argument reaches it
//! untouched), a zip served in place of each download, and folders under a
//! temp directory. Nothing here downloads, installs or elevates anything.

use super::*;
use crate::test_support::TempDir;
use std::cell::RefCell;
use std::collections::VecDeque;
use std::io::Write;
use std::sync::Arc;
use zip::write::SimpleFileOptions;

const MODE: &str = "LATTICE_FAKE_PROGRAM";
const EXE: &str = "LATTICE_FAKE_EXE";
/// The pid a stand-in program wrote to `file`, once it has.
fn written_pid(file: &std::path::Path) -> u32 {
    for _ in 0..200 {
        if let Ok(text) = std::fs::read_to_string(file) {
            if let Ok(pid) = text.trim().parse() {
                return pid;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    panic!("no pid written to {}", file.display());
}

fn alive(pid: u32) -> bool {
    let out =
        Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
}

/// True once the process has ended (waits up to 10 s for it to).
fn gone(pid: u32) -> bool {
    for _ in 0..100 {
        if !alive(pid) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    false
}

const TEST_NAME: &str = "tex_setup::windows::tests::fake_entry";

/// Which way a stand-in installer or package manager behaves, per call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Run {
    Succeed,
    NetworkFailure,
    OtherFailure,
    Hang,
}

impl Run {
    fn name(self) -> &'static str {
        match self {
            Self::Succeed => "succeed",
            Self::NetworkFailure => "network",
            Self::OtherFailure => "other",
            Self::Hang => "hang",
        }
    }
}

/// A machine in a temp folder. Per-call behaviours are consumed in order; the
/// last one repeats.
struct Fake {
    dir: TempDir,
    script: PathBuf,
    local_app_data: Option<PathBuf>,
    year: i32,
    installer_runs: RefCell<VecDeque<Run>>,
    tlmgr_runs: RefCell<VecDeque<Run>>,
    miktex_runs: RefCell<VecDeque<Run>>,
    /// Programs named here fail their version check.
    broken_tools: Vec<&'static str>,
    resolved: RefCell<std::collections::HashMap<&'static str, PathBuf>>,
    /// The TeX Live release `tlmgr --version` reports.
    tl_year: std::cell::Cell<i32>,
    downloads: RefCell<Vec<&'static str>>,
    download_error: Option<String>,
    /// Downloads hang until cancelled.
    download_stalls: bool,
    /// The 8.3 short name `GetShortPathName` gives one folder: (long, short).
    short: Option<(PathBuf, PathBuf)>,
    /// Text `tlmgr search` and `miktex packages list` print.
    listing: RefCell<String>,
    /// A file `tlmgr install`/`miktex packages install` creates for the
    /// dependency `kpsewhich` looks up.
    provides: RefCell<Option<(String, PathBuf)>>,
}

fn queue(runs: &[Run]) -> RefCell<VecDeque<Run>> {
    RefCell::new(runs.iter().copied().collect())
}

impl Fake {
    fn new() -> Self {
        let dir = TempDir::new("tex-windows-flow");
        // Runs this test binary as the program and hands back only what the
        // program itself printed: the harness announces and summarises the
        // test on stdout, and a tool whose output is read must not carry that.
        let script = dir.write(
            "fake.cmd",
            format!(
                "@echo off\r\nsetlocal\r\nset \"OUT=%TEMP%\\lattice-fake-%LATTICE_FAKE_TOKEN%.out\"\r\n\
                 set \"ERR=%OUT%.err\"\r\n\
                 \"%{EXE}%\" --exact {TEST_NAME} --nocapture -- %* >\"%OUT%\" 2>\"%ERR%\"\r\n\
                 set \"CODE=%ERRORLEVEL%\"\r\n\
                 findstr /v /b /c:\"running 1 test\" /c:\"test tex_setup\" /c:\"test result:\" \"%OUT%\"\r\n\
                 type \"%ERR%\" 1>&2\r\n\
                 del \"%OUT%\" \"%ERR%\" 2>nul\r\n\
                 exit /b %CODE%\r\n"
            ),
        );
        // The fonts the verification looks for, and the package files the
        // templates load.
        for file in crate::doctor::CONFERENCE_FONT_FILES.iter().chain(&tex_live::TEMPLATE_FILES) {
            dir.write(&format!("fonts/{file}"), "font");
        }
        let local = dir.join("Ada Lovelace").join("AppData").join("Local");
        Self {
            dir,
            script,
            local_app_data: Some(local),
            year: 2026,
            installer_runs: queue(&[Run::Succeed]),
            tlmgr_runs: queue(&[Run::Succeed]),
            miktex_runs: queue(&[Run::Succeed]),
            broken_tools: Vec::new(),
            resolved: RefCell::new(Default::default()),
            tl_year: std::cell::Cell::new(2026),
            downloads: RefCell::new(Vec::new()),
            download_error: None,
            download_stalls: false,
            short: None,
            listing: RefCell::new(String::new()),
            provides: RefCell::new(None),
        }
    }

    fn tools(&self) -> PathBuf {
        self.dir.join("tools").join("uv-0.12.3")
    }

    /// The folder the `install-tl` stand-in was last run in (it logs its
    /// working directory).
    fn installer_dir(&self) -> PathBuf {
        PathBuf::from(std::fs::read_to_string(self.dir.join("install-tl.cwd")).unwrap())
    }

    fn next(runs: &RefCell<VecDeque<Run>>) -> Run {
        let mut runs = runs.borrow_mut();
        if runs.len() > 1 {
            runs.pop_front().unwrap()
        } else {
            *runs.front().unwrap()
        }
    }

    fn command(&self, program: &str) -> Command {
        let mut command = Command::new(&self.script);
        command
            .env(MODE, program)
            .env(EXE, std::env::current_exe().unwrap())
            .env("LATTICE_FAKE_DIR", &*self.dir)
            .env("LATTICE_FAKE_TOKEN", uuid::Uuid::new_v4().simple().to_string());
        command
    }

    fn put_zip(&self, path: &Path, entries: &[(&str, &[u8])]) {
        let mut writer = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        for (name, bytes) in entries {
            writer.start_file(*name, SimpleFileOptions::default()).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
    }

    /// A working TeX Live of `year` under the scratch drive, with a
    /// `tlpkg` folder when `writable`.
    fn existing_tex_live(&self, year: i32, writable: bool) -> PathBuf {
        let root = self.dir.join("system").join("texlive").join(year.to_string());
        let bin = tex_live::bin_dir(&root);
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("tlmgr.bat"), "").unwrap();
        std::fs::write(bin.join("kpsewhich.exe"), "").unwrap();
        if writable {
            std::fs::create_dir_all(root.join("tlpkg")).unwrap();
            // A finished install has the marker `install-tl` writes last.
            std::fs::write(root.join("tlpkg").join("texlive.profile"), "").unwrap();
        }
        self.tl_year.set(year);
        self.resolved.borrow_mut().insert("tlmgr", tex_live::tlmgr_path(&root));
        self.resolved.borrow_mut().insert("kpsewhich", bin.join("kpsewhich.exe"));
        root
    }

    /// What the stand-in programs were asked, one call per line, without the
    /// quotes a batch file's arguments arrive in.
    fn log(&self) -> String {
        std::fs::read_to_string(self.dir.join("calls.log")).unwrap_or_default().replace('"', "")
    }
}

impl Host for Fake {
    fn local_app_data(&self) -> Option<PathBuf> {
        self.local_app_data.clone()
    }

    fn short_path(&self, path: &Path) -> Option<PathBuf> {
        let (long, short) = self.short.as_ref()?;
        (path == long).then(|| short.clone())
    }

    fn current_year(&self) -> i32 {
        self.year
    }

    fn temp_dir(&self) -> PathBuf {
        let temp = self.dir.join("temp");
        std::fs::create_dir_all(&temp).unwrap();
        temp
    }

    fn tools_dir(&self) -> Option<PathBuf> {
        Some(self.tools())
    }

    fn download(
        &self, pinned: &PinnedDownload, path: &Path, cancel: &AtomicBool,
        on_bytes: &mut dyn FnMut(u64, u64),
    ) -> Result<(), String> {
        self.downloads.borrow_mut().push(pinned.name);
        if self.download_stalls {
            // A server that has gone silent: only Cancel ends it.
            std::fs::write(self.dir.join("download.started"), "").unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
            while !cancel.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            return Err(super::super::fetch::DOWNLOAD_CANCELLED.into());
        }
        if let Some(error) = &self.download_error {
            return Err(error.clone());
        }
        match pinned.name {
            "uv" => {
                self.put_zip(path, &[("uv.exe", b"uv"), ("uvw.exe", b"uvw"), ("uvx.exe", b"uvx")])
            }
            _ => self.put_zip(
                path,
                &[
                    ("install-tl-20260301/install-tl-windows.bat", b"@echo off\r\n"),
                    ("install-tl-20260301/install-tl", b"#!perl\n"),
                ],
            ),
        }
        let size = std::fs::metadata(path).unwrap().len();
        on_bytes(size / 2, size);
        on_bytes(size, size);
        Ok(())
    }

    fn installer_command(&self, _installer: &Path, args: &[String], cwd: &Path) -> Command {
        let mut command = self.command("install-tl");
        command
            .args(args)
            .current_dir(cwd)
            .env("LATTICE_FAKE_RUN", Self::next(&self.installer_runs).name());
        command
    }

    fn program(&self, path: &Path) -> Command {
        let stem = path.file_stem().unwrap().to_string_lossy().into_owned();
        let run = match stem.as_str() {
            "miktex" => Self::next(&self.miktex_runs),
            "tlmgr" => Self::next(&self.tlmgr_runs),
            _ => Run::Succeed,
        };
        let mut command = self.command(&stem);
        command
            .env("LATTICE_FAKE_RUN", run.name())
            .env("LATTICE_FAKE_YEAR", self.tl_year.get().to_string());
        command.env("LATTICE_FAKE_LISTING", &*self.listing.borrow());
        if let Some((_, create)) = &*self.provides.borrow() {
            command.env("LATTICE_FAKE_CREATE", create);
        }
        command
    }

    fn tool_command(&self, name: &str) -> Command {
        let mut command = self.command(name);
        command
            .env("LATTICE_FAKE_FONTS", self.dir.join("fonts"))
            .env("LATTICE_FAKE_BROKEN", self.broken_tools.join(","));
        command
    }

    fn resolved_tool(&self, name: &str) -> Option<PathBuf> {
        self.resolved.borrow().get(name).cloned()
    }

    fn uv_status(&self, name: &str) -> Result<(), String> {
        self.uv_status_at(&self.tools().join(format!("{name}.exe")), name)
    }

    fn uv_status_at(&self, path: &Path, name: &str) -> Result<(), String> {
        if path.is_file() {
            Ok(())
        } else {
            Err(format!("{} is not installed ({name}).", path.display()))
        }
    }
}

/// Runs only when started through the batch file by [`Fake::command`]; a plain
/// `cargo test` passes it.
#[test]
fn fake_entry() {
    let Ok(program) = std::env::var(MODE) else { return };
    let args: Vec<String> = std::env::args().skip_while(|arg| arg != "--").skip(1).collect();
    let run = std::env::var("LATTICE_FAKE_RUN").unwrap_or_else(|_| "succeed".into());
    let scratch = PathBuf::from(std::env::var("LATTICE_FAKE_DIR").unwrap());
    let mut log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(scratch.join("calls.log"))
        .unwrap();
    writeln!(log, "{program} {}", args.join(" ")).unwrap();
    fn fail(text: &str) -> ! {
        eprintln!("{text}");
        std::process::exit(1)
    }
    match program.as_str() {
        "install-tl" => {
            std::fs::write(
                scratch.join("install-tl.cwd"),
                std::env::current_dir().unwrap().to_string_lossy().as_bytes(),
            )
            .unwrap();
            let profile = std::fs::read_to_string("profile.txt").expect("no profile.txt");
            let texdir = profile
                .lines()
                .find_map(|line| line.strip_prefix("TEXDIR "))
                .expect("no TEXDIR in the profile");
            let texdir = PathBuf::from(texdir);
            std::fs::create_dir_all(&texdir).unwrap();
            std::fs::write(texdir.join("partial.txt"), "half").unwrap();
            // `tlmgr.bat` ships in package 127 of 135, long before the install ends.
            let early_bin = texdir.join("bin").join("windows");
            std::fs::create_dir_all(&early_bin).unwrap();
            std::fs::write(early_bin.join("tlmgr.bat"), "").unwrap();
            println!("Installing [001/003, time/total: ??:??/??:??]: one [8k]");
            match run.as_str() {
                "network" => fail("tlmgr: TLPDB::from_file could not get texlive.tlpdb"),
                "other" => fail("tlmgr: package texlive.infra not present in repository."),
                "hang" => {
                    std::fs::write(scratch.join("hang.pid"), std::process::id().to_string())
                        .unwrap();
                    std::thread::sleep(std::time::Duration::from_secs(120));
                }
                _ => {
                    println!("Installing [003/003, time/total: ??:??/??:??]: three [8k]");
                    let bin = texdir.join("bin").join("windows");
                    std::fs::create_dir_all(&bin).unwrap();
                    std::fs::write(bin.join("tlmgr.bat"), "").unwrap();
                    std::fs::remove_file(texdir.join("partial.txt")).unwrap();
                    // Written only in the installer's final cleanup.
                    std::fs::create_dir_all(texdir.join("tlpkg")).unwrap();
                    std::fs::write(texdir.join("tlpkg").join("texlive.profile"), "").unwrap();
                }
            }
        }
        "tlmgr" | "miktex" => {
            let has = |word: &str| args.iter().any(|arg| arg == word);
            let with_mirror = has("--repository");
            if has("--version") {
                println!("tlmgr revision 76773 (2025-11-06 15:48:23 +0100)");
                println!(
                    "TeX Live (https://tug.org/texlive) version {}",
                    std::env::var("LATTICE_FAKE_YEAR").unwrap_or_default()
                );
            } else if has("search") || (program == "miktex" && has("list")) {
                if run == "network" && !with_mirror {
                    fail("tlmgr: TLPDB::from_file could not get texlive.tlpdb");
                }
                print!("{}", std::env::var("LATTICE_FAKE_LISTING").unwrap_or_default());
            } else if has("install") || has("update") {
                println!("[1/2, ??:??/??:??] install: one [1k]");
                println!("[2/2, ??:??/??:??] install: two [1k]");
                match run.as_str() {
                    "network" if !with_mirror => {
                        fail("tlmgr: TLPDB::from_file could not get texlive.tlpdb")
                    }
                    "other" => fail("tlmgr: package newtx not present in repository."),
                    "hang" => {
                        std::fs::write(scratch.join("hang.pid"), std::process::id().to_string())
                            .unwrap();
                        std::thread::sleep(std::time::Duration::from_secs(120));
                    }
                    _ => {}
                }
                if has("install") {
                    if let Ok(create) = std::env::var("LATTICE_FAKE_CREATE") {
                        std::fs::write(create, "package").unwrap();
                    }
                }
            }
        }
        "kpsewhich" => {
            let wanted = args.first().cloned().unwrap_or_default();
            if wanted == "--version" {
                println!("kpsewhich fake");
            } else {
                let fonts = std::env::var("LATTICE_FAKE_FONTS").map(PathBuf::from);
                let candidates = [
                    fonts.map(|fonts| fonts.join(&wanted)).unwrap_or_default(),
                    scratch.join("provided").join(&wanted),
                ];
                match candidates.iter().find(|path| path.is_file()) {
                    Some(path) => println!("{}", path.display()),
                    None => std::process::exit(1),
                }
            }
        }
        other => {
            let broken = std::env::var("LATTICE_FAKE_BROKEN").unwrap_or_default();
            if broken.split(',').any(|name| name == other) {
                fail(&format!("{other}: could not find its script engine"));
            }
            println!("{other} fake 1.0");
        }
    }
}

/// Run `body` with a flow over `host` that records its progress events.
fn with_flow<T>(
    host: &Fake, cancel: &AtomicBool, body: impl FnOnce(&Flow<'_>) -> T,
) -> (T, Vec<(String, f64)>) {
    let events = RefCell::new(Vec::new());
    let record =
        |stage: &str, progress: f64| events.borrow_mut().push((stage.to_string(), progress));
    let result = body(&Flow { host, progress: &record, cancel });
    (result, events.into_inner())
}

fn never() -> AtomicBool {
    AtomicBool::new(false)
}

fn assert_progress_is_sane(events: &[(String, f64)]) {
    assert!(!events.is_empty());
    let mut last = 0.0;
    for (stage, progress) in events {
        assert!((0.0..=1.0).contains(progress), "{stage} {progress}");
        assert!(*progress + 1e-9 >= last, "{stage} went back from {last} to {progress}");
        last = *progress;
    }
    assert_eq!(events.last().unwrap(), &("complete".to_string(), 1.0));
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

// ---- tools only ---------------------------------------------------------

#[test]
fn tools_only_installs_the_managed_uv_pair_beside_a_working_tex() {
    let fake = Fake::new();
    let (result, events) =
        with_flow(&fake, &never(), |flow| flow.install_tex(TexInstallMode::ToolsOnly));
    result.unwrap();
    assert_progress_is_sane(&events);
    assert_eq!(*fake.downloads.borrow(), ["uv"]);
    assert_eq!(std::fs::read(fake.tools().join("uv.exe")).unwrap(), b"uv");
    assert_eq!(std::fs::read(fake.tools().join("uvx.exe")).unwrap(), b"uvx");
    // Only the two programs Lattice runs; no staging folder or workspace left.
    assert_eq!(names(&fake.tools()), ["uv.exe", "uvx.exe"]);
    assert_eq!(names(fake.tools().parent().unwrap()), ["uv-0.12.3"]);
    assert!(names(&fake.dir.join("temp")).is_empty(), "the download workspace stayed");
    // The TeX tools were checked before and after.
    let log = fake.log();
    assert!(log.matches("latexmk -version").count() >= 2, "{log}");
}

#[test]
fn tools_only_does_nothing_when_uv_is_already_in_place() {
    let fake = Fake::new();
    std::fs::create_dir_all(fake.tools()).unwrap();
    std::fs::write(fake.tools().join("uv.exe"), "old").unwrap();
    std::fs::write(fake.tools().join("uvx.exe"), "old").unwrap();
    let (result, _) =
        with_flow(&fake, &never(), |flow| flow.install_tex(TexInstallMode::ToolsOnly));
    result.unwrap();
    assert!(fake.downloads.borrow().is_empty());
    assert_eq!(std::fs::read(fake.tools().join("uv.exe")).unwrap(), b"old");
}

#[test]
fn tools_only_refuses_a_tex_that_stopped_working() {
    let mut fake = Fake::new();
    fake.broken_tools = vec!["latexmk"];
    let (result, _) =
        with_flow(&fake, &never(), |flow| flow.install_tex(TexInstallMode::ToolsOnly));
    let error = result.unwrap_err();
    assert!(
        error.starts_with("Your LaTeX setup changed before the required tools install started."),
        "{error}"
    );
    assert!(error.contains("latexmk failed its user-level verification"), "{error}");
    assert!(fake.downloads.borrow().is_empty());
    assert!(!fake.tools().exists());
}

#[test]
fn a_download_that_failed_its_hash_installs_nothing_and_leaves_no_files() {
    let mut fake = Fake::new();
    fake.download_error = Some("The downloaded uv archive failed its security check.".into());
    let (result, _) =
        with_flow(&fake, &never(), |flow| flow.install_tex(TexInstallMode::ToolsOnly));
    assert_eq!(result.unwrap_err(), "The downloaded uv archive failed its security check.");
    assert!(!fake.tools().exists());
    assert!(!fake.dir.join("tools").exists() || names(&fake.dir.join("tools")).is_empty());
    assert!(names(&fake.dir.join("temp")).is_empty());
}

// ---- full install -------------------------------------------------------

fn texdir_of(fake: &Fake) -> PathBuf {
    tex_live::install_location(
        fake.local_app_data().as_deref(),
        |path| fake.short_path(path),
        windows_pins::TEX_LIVE_YEAR,
    )
    .unwrap()
    .texdir
}

#[test]
fn a_full_install_runs_the_installer_then_the_packages_then_uv_and_verifies() {
    let fake = Fake::new();
    let (result, events) =
        with_flow(&fake, &never(), |flow| flow.install_tex(TexInstallMode::Full));
    result.unwrap();
    assert_progress_is_sane(&events);
    let stages: Vec<&str> = events.iter().map(|(stage, _)| stage.as_str()).collect();
    for stage in [
        "downloading",
        "installing-base",
        "installing-packages",
        "installing-tools",
        "verifying",
        "complete",
    ] {
        assert!(stages.contains(&stage), "{stage} missing from {stages:?}");
    }
    assert_eq!(*fake.downloads.borrow(), ["TeX Live", "uv"]);

    let texdir = texdir_of(&fake);
    assert!(tex_live::tlmgr_path(&texdir).is_file(), "{}", texdir.display());
    assert!(!texdir.join("partial.txt").exists());
    // The installer ran per user, from the profile, with nothing but plain arguments.
    let log = fake.log();
    assert!(
        log.contains(&format!(
            "install-tl -no-gui -non-admin -repository {} -profile profile.txt",
            tex_live::PRIMARY_REPOSITORY
        )),
        "{log}"
    );
    // The packages come from the same https mirror the installer used.
    assert!(
        log.contains(&format!("--repository {} install ", tex_live::PRIMARY_REPOSITORY)),
        "{log}"
    );
    // A fresh install is current, so its tlmgr is not updated; the required
    // packages are installed in one call.
    assert!(!log.contains("update --self"), "{log}");
    let install = log
        .lines()
        .find(|line| line.starts_with("tlmgr ") && line.contains(" install latexmk "))
        .expect(&log);
    for package in tex_live::REQUIRED_PACKAGES {
        assert!(install.split(' ').any(|arg| arg == package), "{package} in {install}");
    }
    // The workspace under the TeX Live folder is gone.
    let parent = texdir.parent().unwrap();
    assert_eq!(names(parent), [windows_pins::TEX_LIVE_YEAR.to_string()]);
    assert_eq!(names(fake.tools().parent().unwrap()), ["uv-0.12.3"]);
}

#[test]
fn a_profile_folder_the_installer_cannot_read_installs_under_its_short_name() {
    let mut fake = Fake::new();
    let long = fake.dir.join("Zoë Å").join("AppData").join("Local");
    let short = fake.dir.join("ZOE_1").join("AppData").join("Local");
    fake.local_app_data = Some(long.clone());
    fake.short = Some((long.clone(), short.clone()));
    let (result, _) = with_flow(&fake, &never(), |flow| flow.install_tex(TexInstallMode::Full));
    result.unwrap();
    let texdir = short.join("Programs").join("texlive").join("2026");
    assert!(tex_live::tlmgr_path(&texdir).is_file(), "{}", texdir.display());
    // Nothing under the unreadable name, and nothing under a drive's root.
    assert!(!long.join("Programs").exists());
    assert!(!fake.dir.join("drive").exists() && !fake.dir.join("texlive").exists());
    // The installer ran from this run's own folder in the user's Temp, now gone.
    assert!(names(&short.join("Temp")).is_empty(), "{:?}", names(&short.join("Temp")));
}

#[test]
fn without_a_readable_path_for_the_profile_nothing_is_downloaded_or_installed() {
    let mut fake = Fake::new();
    fake.local_app_data = Some(fake.dir.join("Zoë Å").join("AppData").join("Local"));
    let (result, events) =
        with_flow(&fake, &never(), |flow| flow.install_tex(TexInstallMode::Full));
    let error = result.unwrap_err();
    assert_eq!(error, tex_live::NO_SAFE_LOCATION);
    assert!(fake.downloads.borrow().is_empty(), "downloaded before refusing");
    assert!(events.iter().all(|(stage, _)| stage != "complete"));
    assert!(!fake.log().contains("install-tl "));
    assert!(!fake.dir.join("drive").exists() && !fake.dir.join("texlive").exists());
}

#[test]
fn a_usable_tex_live_is_used_even_when_the_profile_folder_has_no_safe_path() {
    let mut fake = Fake::new();
    fake.local_app_data = Some(fake.dir.join("Zoë Å").join("AppData").join("Local"));
    fake.existing_tex_live(2026, true);
    let (result, _) = with_flow(&fake, &never(), |flow| flow.install_tex(TexInstallMode::Full));
    result.unwrap();
    assert_eq!(*fake.downloads.borrow(), ["uv"]);
}

#[test]
fn the_installer_runs_from_a_private_folder_of_the_users_temp_not_the_install_folder() {
    let fake = Fake::new();
    let (result, _) = with_flow(&fake, &never(), |flow| flow.install_tex(TexInstallMode::Full));
    result.unwrap();
    let local = fake.local_app_data().unwrap();
    let working = fake.installer_dir();
    assert!(working.starts_with(local.join("Temp")), "{}", working.display());
    assert!(!working.starts_with(local.join("Programs")), "{}", working.display());
}

#[test]
fn cancelling_during_a_download_ends_it_at_once_and_installs_nothing() {
    let mut fake = Fake::new();
    fake.download_stalls = true;
    let cancel = Arc::new(AtomicBool::new(false));
    let started = fake.dir.join("download.started");
    let watcher = {
        let (cancel, started) = (Arc::clone(&cancel), started.clone());
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
            while !started.exists() && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            cancel.store(true, Ordering::Release);
        })
    };
    let begun = std::time::Instant::now();
    let (result, _) = with_flow(&fake, &cancel, |flow| flow.install_tex(TexInstallMode::Full));
    watcher.join().unwrap();
    assert_eq!(result.unwrap_err(), CANCELLED);
    assert!(begun.elapsed() < std::time::Duration::from_secs(10), "{:?}", begun.elapsed());
    assert!(!fake.log().contains("install-tl "));
    assert!(!texdir_of(&fake).exists());
}

#[test]
fn a_template_package_the_install_missed_is_named() {
    let fake = Fake::new();
    std::fs::remove_file(fake.dir.join("fonts").join("lineno.sty")).unwrap();
    std::fs::remove_file(fake.dir.join("fonts").join("xeCJK.sty")).unwrap();
    let (result, events) =
        with_flow(&fake, &never(), |flow| flow.install_tex(TexInstallMode::Full));
    assert_eq!(
        result.unwrap_err(),
        "TeX Live was installed, but Lattice's templates need files it could not find: lineno.sty, xeCJK.sty. Click Install TeX Live again, or install their packages with tlmgr."
    );
    assert!(events.iter().all(|(stage, _)| stage != "complete"));
}

#[test]
fn a_network_failure_tries_the_next_mirror_on_a_clean_tree() {
    let fake = Fake::new();
    *fake.installer_runs.borrow_mut() = queue(&[Run::NetworkFailure, Run::Succeed]).into_inner();
    let (result, _) = with_flow(&fake, &never(), |flow| flow.install_tex(TexInstallMode::Full));
    result.unwrap();
    let log = fake.log();
    let runs: Vec<&str> = log.lines().filter(|line| line.starts_with("install-tl ")).collect();
    assert_eq!(runs.len(), 2, "{log}");
    assert!(
        runs[0].contains(&format!("-repository {}", tex_live::PRIMARY_REPOSITORY)),
        "the first attempt names its https mirror too: {}",
        runs[0]
    );
    assert!(
        runs[1].contains(&format!("-repository {}", tex_live::FALLBACK_REPOSITORIES[0])),
        "{}",
        runs[1]
    );
    // The first attempt's half-written tree was removed, not built upon.
    assert!(!texdir_of(&fake).join("partial.txt").exists());
}

#[test]
fn a_half_installed_tree_with_a_package_manager_is_removed_after_a_failure() {
    let fake = Fake::new();
    *fake.installer_runs.borrow_mut() = queue(&[Run::OtherFailure]).into_inner();
    let (result, _) = with_flow(&fake, &never(), |flow| flow.install_tex(TexInstallMode::Full));
    result.unwrap_err();
    // The stand-in installer left `tlmgr.bat` behind but no marker, as the real one does
    // when it fails after installing `texlive.infra`.
    assert!(!texdir_of(&fake).exists(), "a tree that never finished was kept");
}

#[test]
fn a_half_installed_tree_is_replaced_not_reused_by_the_next_install() {
    let fake = Fake::new();
    let texdir = texdir_of(&fake);
    let bin = tex_live::bin_dir(&texdir);
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(texdir.join("tlpkg")).unwrap();
    std::fs::write(tex_live::tlmgr_path(&texdir), "").unwrap();
    std::fs::write(bin.join("kpsewhich.exe"), "").unwrap();
    std::fs::write(texdir.join("old-half.txt"), "half").unwrap();
    fake.tl_year.set(2026);
    fake.resolved.borrow_mut().insert("tlmgr", tex_live::tlmgr_path(&texdir));
    fake.resolved.borrow_mut().insert("kpsewhich", bin.join("kpsewhich.exe"));
    let (result, _) = with_flow(&fake, &never(), |flow| flow.install_tex(TexInstallMode::Full));
    result.unwrap();
    assert!(fake.log().contains("install-tl "), "the half tree was reused: {}", fake.log());
    assert!(!texdir.join("old-half.txt").exists(), "the old half tree was built upon");
    assert!(tex_live::is_finished_install(&texdir));
}

#[test]
fn a_finished_install_at_the_install_folder_is_reused() {
    let fake = Fake::new();
    let texdir = texdir_of(&fake);
    let bin = tex_live::bin_dir(&texdir);
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(texdir.join("tlpkg")).unwrap();
    std::fs::write(texdir.join("tlpkg").join("texlive.profile"), "").unwrap();
    std::fs::write(tex_live::tlmgr_path(&texdir), "").unwrap();
    std::fs::write(bin.join("kpsewhich.exe"), "").unwrap();
    fake.tl_year.set(2026);
    fake.resolved.borrow_mut().insert("tlmgr", tex_live::tlmgr_path(&texdir));
    fake.resolved.borrow_mut().insert("kpsewhich", bin.join("kpsewhich.exe"));
    let (result, _) = with_flow(&fake, &never(), |flow| flow.install_tex(TexInstallMode::Full));
    result.unwrap();
    assert!(!fake.log().contains("install-tl "), "a finished tree was reinstalled");
}

#[test]
fn a_failure_that_is_not_the_network_stops_at_once_and_removes_the_half_installed_tree() {
    let fake = Fake::new();
    *fake.installer_runs.borrow_mut() = queue(&[Run::OtherFailure]).into_inner();
    let (result, _) = with_flow(&fake, &never(), |flow| flow.install_tex(TexInstallMode::Full));
    let error = result.unwrap_err();
    assert_eq!(
        error,
        "TeX Live installation failed.\ntlmgr: package texlive.infra not present in repository."
    );
    assert_eq!(fake.log().matches("install-tl ").count(), 1);
    assert!(!texdir_of(&fake).exists(), "a half-installed TeX Live stayed");
    assert!(names(texdir_of(&fake).parent().unwrap()).is_empty(), "the workspace stayed");
    assert!(!fake.tools().exists(), "uv was installed after a failed TeX install");
}

#[test]
fn every_mirror_failing_reports_the_installers_words() {
    let fake = Fake::new();
    *fake.installer_runs.borrow_mut() = queue(&[Run::NetworkFailure]).into_inner();
    let (result, _) = with_flow(&fake, &never(), |flow| flow.install_tex(TexInstallMode::Full));
    let error = result.unwrap_err();
    assert!(error.starts_with("TeX Live installation failed.\n"), "{error}");
    assert!(error.contains("could not get texlive.tlpdb"), "{error}");
    assert_eq!(fake.log().matches("install-tl ").count(), 3);
    assert!(!texdir_of(&fake).exists());
}

#[test]
fn a_failure_while_installing_packages_leaves_tex_live_in_and_says_so() {
    let fake = Fake::new();
    *fake.tlmgr_runs.borrow_mut() = queue(&[Run::OtherFailure]).into_inner();
    let (result, _) = with_flow(&fake, &never(), |flow| flow.install_tex(TexInstallMode::Full));
    let error = result.unwrap_err();
    assert!(error.starts_with("TeX Live is installed, but Lattice could not finish installing the required LaTeX packages.\n"), "{error}");
    assert!(error.contains("package newtx not present in repository"), "{error}");
    assert!(tex_live::tlmgr_path(&texdir_of(&fake)).is_file());
}

#[test]
fn cancelling_the_installer_ends_its_processes_and_removes_the_partial_tree() {
    let fake = Fake::new();
    *fake.installer_runs.borrow_mut() = queue(&[Run::Hang]).into_inner();
    let cancel = Arc::new(AtomicBool::new(false));
    let pid_file = fake.dir.join("hang.pid");
    let watcher = {
        let (cancel, pid_file) = (Arc::clone(&cancel), pid_file.clone());
        std::thread::spawn(move || {
            let pid = written_pid(&pid_file);
            assert!(alive(pid));
            cancel.store(true, Ordering::Release);
            pid
        })
    };
    let (result, events) = with_flow(&fake, &cancel, |flow| flow.install_tex(TexInstallMode::Full));
    assert_eq!(result.unwrap_err(), CANCELLED);
    assert!(gone(watcher.join().unwrap()), "the installer survived a cancel");
    assert!(events.iter().all(|(stage, _)| stage != "complete"));
    assert!(!texdir_of(&fake).exists(), "a cancelled install left its tree");
    assert!(names(texdir_of(&fake).parent().unwrap()).is_empty());
    assert!(!fake.tools().exists());
}

#[test]
fn cancelling_before_the_installer_starts_installs_nothing() {
    let fake = Fake::new();
    let cancel = AtomicBool::new(true);
    let (result, _) = with_flow(&fake, &cancel, |flow| flow.install_tex(TexInstallMode::Full));
    assert_eq!(result.unwrap_err(), CANCELLED);
    assert!(!fake.log().contains("install-tl "));
    assert!(!texdir_of(&fake).exists());
}

#[test]
fn an_install_after_the_pinned_release_year_asks_for_a_lattice_update() {
    let mut fake = Fake::new();
    fake.year = 2027;
    let (result, _) = with_flow(&fake, &never(), |flow| flow.install_tex(TexInstallMode::Full));
    assert_eq!(
        result.unwrap_err(),
        "This Lattice version includes TeX Live 2026. Update Lattice to install the current TeX Live release."
    );
    assert!(fake.downloads.borrow().is_empty());
}

#[test]
fn a_current_writable_tex_live_is_reused_and_only_its_packages_are_installed() {
    let fake = Fake::new();
    fake.existing_tex_live(2026, true);
    let (result, events) =
        with_flow(&fake, &never(), |flow| flow.install_tex(TexInstallMode::Full));
    result.unwrap();
    assert_progress_is_sane(&events);
    // No installer was downloaded or run; tlmgr updated itself, then installed.
    assert_eq!(*fake.downloads.borrow(), ["uv"]);
    let log = fake.log();
    assert!(!log.contains("install-tl "), "{log}");
    let update = log.find("tlmgr update --self").expect(&log);
    let install = log.find("tlmgr install ").expect(&log);
    assert!(update < install);
}

#[test]
fn an_old_or_unwritable_tex_live_is_left_alone_and_a_new_one_installed() {
    for (year, writable) in [(2025, true), (2026, false)] {
        let fake = Fake::new();
        let existing = fake.existing_tex_live(year, writable);
        let (result, _) = with_flow(&fake, &never(), |flow| flow.install_tex(TexInstallMode::Full));
        result.unwrap();
        assert_eq!(*fake.downloads.borrow(), ["TeX Live", "uv"], "{year} {writable}");
        assert!(tex_live::tlmgr_path(&texdir_of(&fake)).is_file());
        // The old tree was never written to.
        assert_eq!(
            names(&existing),
            if writable { ["bin", "tlpkg"].to_vec() } else { ["bin"].to_vec() }
        );
    }
}

#[test]
fn a_tex_that_installs_but_cannot_run_a_required_tool_is_reported() {
    let mut fake = Fake::new();
    fake.broken_tools = vec!["biber"];
    let (result, events) =
        with_flow(&fake, &never(), |flow| flow.install_tex(TexInstallMode::Full));
    let error = result.unwrap_err();
    assert!(error.starts_with("biber failed its user-level verification."), "{error}");
    assert!(events.iter().all(|(stage, _)| stage != "complete"));
}

// ---- a missing package ----------------------------------------------------

const SEARCH: &str = "newtx:\n    texmf-dist/tex/latex/newtx/newtxmath.sty\n    \
    texmf-dist/tex/latex/newtx/newtxtext.sty\nother:\n    texmf-dist/tex/latex/other/other.sty\n";

fn provided(fake: &Fake, file: &str) -> PathBuf {
    let path = fake.dir.join("provided").join(file);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    path
}

#[test]
fn a_missing_package_is_found_installed_and_verified_with_tex_live() {
    let fake = Fake::new();
    fake.existing_tex_live(2026, true);
    *fake.listing.borrow_mut() = SEARCH.into();
    *fake.provides.borrow_mut() = Some(("newtxmath.sty".into(), provided(&fake, "newtxmath.sty")));
    let (result, events) =
        with_flow(&fake, &never(), |flow| flow.install_dependency("newtxmath.sty", None));
    result.unwrap();
    assert_progress_is_sane(&events);
    let log = fake.log();
    assert!(log.contains("search --global --file /newtxmath\\.sty$"), "{log}");
    assert!(log.contains("tlmgr install newtx"), "{log}");
    assert!(log.find("update --self").unwrap() < log.find("tlmgr install newtx").unwrap());
}

#[test]
fn a_package_that_is_already_there_installs_nothing() {
    let fake = Fake::new();
    fake.existing_tex_live(2026, true);
    std::fs::write(provided(&fake, "algorithm.sty"), "x").unwrap();
    let (result, events) =
        with_flow(&fake, &never(), |flow| flow.install_dependency("algorithm.sty", None));
    result.unwrap();
    assert_eq!(events.last().unwrap(), &("complete".to_string(), 1.0));
    assert!(!fake.log().contains("tlmgr "), "{}", fake.log());
}

#[test]
fn an_unknown_package_is_an_error_and_a_tie_asks_the_writer_with_nothing_installed() {
    let fake = Fake::new();
    fake.existing_tex_live(2026, true);
    *fake.listing.borrow_mut() = SEARCH.into();
    let (result, _) =
        with_flow(&fake, &never(), |flow| flow.install_dependency("custom.sty", None));
    assert!(result.unwrap_err().starts_with("No TeX Live package provides custom.sty."));
    *fake.listing.borrow_mut() = "a:\n    x/shared.sty\nb:\n    y/shared.sty\n".into();
    let (result, _) =
        with_flow(&fake, &never(), |flow| flow.install_dependency("shared.sty", None));
    assert_eq!(
        result.unwrap(),
        TexDependencyInstall::ChoosePackage { packages: vec!["a".into(), "b".into()] }
    );
    assert!(!fake.log().contains("tlmgr install"), "{}", fake.log());
    // A pick that is not one of the tied packages is not installed either.
    let (result, _) =
        with_flow(&fake, &never(), |flow| flow.install_dependency("shared.sty", Some("zzz")));
    assert!(matches!(result.unwrap(), TexDependencyInstall::ChoosePackage { .. }));
    assert!(!fake.log().contains("tlmgr install"), "{}", fake.log());
}

#[test]
fn the_search_and_install_fall_back_to_a_mirror_when_the_default_is_unreachable() {
    let fake = Fake::new();
    fake.existing_tex_live(2026, true);
    *fake.listing.borrow_mut() = SEARCH.into();
    *fake.tlmgr_runs.borrow_mut() = queue(&[Run::NetworkFailure]).into_inner();
    *fake.provides.borrow_mut() = Some(("newtxmath.sty".into(), provided(&fake, "newtxmath.sty")));
    let (result, _) =
        with_flow(&fake, &never(), |flow| flow.install_dependency("newtxmath.sty", None));
    result.unwrap();
    let log = fake.log();
    let mirror = tex_live::FALLBACK_REPOSITORIES[0];
    assert!(log.contains(&format!("--repository {mirror} search --global --file")), "{log}");
    // The install goes straight to the mirror the package was found in.
    assert!(log.contains(&format!("--repository {mirror} install newtx")), "{log}");
}

#[test]
fn a_failed_package_install_names_the_cause() {
    let fake = Fake::new();
    fake.existing_tex_live(2026, true);
    *fake.listing.borrow_mut() = SEARCH.into();
    // The search works; the install is refused.
    *fake.tlmgr_runs.borrow_mut() = queue(&[Run::Succeed, Run::OtherFailure]).into_inner();
    let (result, _) =
        with_flow(&fake, &never(), |flow| flow.install_dependency("newtxmath.sty", None));
    let error = result.unwrap_err();
    assert!(error.starts_with("The package repository does not have this package.\n"), "{error}");
}

#[test]
fn a_missing_package_is_installed_through_miktex_in_user_mode() {
    let fake = Fake::new();
    let bin = fake
        .dir
        .join("Local")
        .join("Programs")
        .join("MiKTeX")
        .join("miktex")
        .join("bin")
        .join("x64");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("kpsewhich.exe"), "").unwrap();
    std::fs::write(bin.join("miktex.exe"), "").unwrap();
    fake.resolved.borrow_mut().insert("kpsewhich", bin.join("kpsewhich.exe"));
    *fake.listing.borrow_mut() =
        "algorithms|texmf/tex/latex/algorithms/algorithm.sty\nother|x/y.sty\n".into();
    *fake.provides.borrow_mut() = Some(("algorithm.sty".into(), provided(&fake, "algorithm.sty")));
    let (result, events) =
        with_flow(&fake, &never(), |flow| flow.install_dependency("algorithm.sty", None));
    result.unwrap();
    assert_progress_is_sane(&events);
    let log = fake.log();
    assert!(log.contains("miktex packages list --template {id}|{runFiles}"), "{log}");
    assert!(log.contains("miktex packages install algorithms"), "{log}");
    // Never in administrator mode.
    assert!(!log.contains("--admin"), "{log}");
    assert!(!log.contains("tlmgr"), "{log}");
}

#[test]
fn a_miktex_package_nobody_provides_is_an_error() {
    let fake = Fake::new();
    let bin = fake.dir.join("miktex").join("bin").join("x64");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("kpsewhich.exe"), "").unwrap();
    std::fs::write(bin.join("miktex.exe"), "").unwrap();
    fake.resolved.borrow_mut().insert("kpsewhich", bin.join("kpsewhich.exe"));
    *fake.listing.borrow_mut() = "algorithms|x/algorithm.sty\n".into();
    let (result, _) =
        with_flow(&fake, &never(), |flow| flow.install_dependency("custom.sty", None));
    assert!(result.unwrap_err().starts_with("No MiKTeX package provides custom.sty."));
    assert!(!fake.log().contains("packages install"));
}

#[test]
fn without_any_tex_there_is_no_package_manager_to_ask() {
    let fake = Fake::new();
    let (result, _) = with_flow(&fake, &never(), |flow| flow.install_dependency("x.sty", None));
    assert_eq!(result.unwrap_err(), "TeX Live's package manager is not installed.");
}

// ---- the one-install-at-a-time guard -------------------------------------

#[test]
fn only_one_install_runs_and_cancel_reaches_it() {
    assert!(!cancel_install());
    let first = InstallGuard::acquire().unwrap();
    let second = InstallGuard::acquire();
    assert_eq!(
        second.err().as_deref(),
        Some("Required setup is already running in another Lattice window.")
    );
    assert!(cancel_install());
    assert!(CANCEL.load(Ordering::Acquire));
    drop(first);
    assert!(!cancel_install());
    // The next install starts with the flag clear.
    let _again = InstallGuard::acquire().unwrap();
    assert!(!CANCEL.load(Ordering::Acquire));
}
