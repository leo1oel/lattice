//! Lattice's LaTeX writing flow on GPUI, in Lattice's look: a project folder
//! in a file tree, Zed's editor with LaTeX highlighting and search, a PDFium
//! preview, latexmk builds with diagnostics, all in GPUI Kit's dockable
//! panels drawn as the Tauri app draws its own.
//!
//! Usage: `lattice-gpui [PROJECT_DIR]`; scripted runs (`e2e` on macOS and
//! Windows, the measurements on macOS):
//! `lattice-gpui PROJECT_DIR --scenario e2e|perf|ime --out RESULT.json`.

mod app;
mod assets;
mod build;
mod build_panel;
mod confirm;
mod editor_panel;
mod editor_status;
mod file_tree;
mod gallery;
mod moved_paths;
#[cfg(target_os = "macos")]
mod native;
#[cfg(target_os = "windows")]
#[path = "native_windows.rs"]
mod native;
mod notices;
mod paint_probe;
mod panels;
mod pdf;
mod project;
#[cfg(any(target_os = "macos", target_os = "windows"))]
mod scenario;
mod shell;
mod stand_in_panels;
mod titlebar;

fn main() {
    init_logging();
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let (root, scenario) = scenario::parse_args();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let root = std::env::args_os().nth(1).map(std::path::PathBuf::from);

    // The parity harness's named regions are recorded from the first frame.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if scenario
        .as_ref()
        .is_some_and(|scenario| scenario.name == "parity")
    {
        lattice_ui::parity::enable();
    }

    gpui_kit::application()
        .with_assets(assets::Assets)
        .run(move |cx| {
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            app::init(scenario.is_some(), cx);
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            app::init(false, cx);
            // `--gallery`: the component sheet instead of a project window.
            if std::env::args().any(|arg| arg == "--gallery") {
                if let Err(error) = gallery::open(cx) {
                    log::error!("could not open the gallery: {error:#}");
                    cx.quit();
                }
                cx.activate(true);
                return;
            }
            // A scripted measurement leaves the user's frontmost app alone.
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            let activate = scenario.is_none();
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            let activate = true;
            match shell::Shell::open_window(root, cx) {
                Ok((_window, _shell)) =>
                {
                    #[cfg(any(target_os = "macos", target_os = "windows"))]
                    if let Some(scenario) = scenario {
                        scenario::start(_shell, _window, scenario, cx);
                    }
                }
                Err(error) => {
                    log::error!("could not open the window: {error:#}");
                    cx.quit();
                }
            }
            if activate {
                cx.activate(true);
            }
        });
}

/// Warnings and errors to stderr; `LATTICE_GPUI_LOG=info` for more.
fn init_logging() {
    struct StderrLogger(log::LevelFilter);

    impl log::Log for StderrLogger {
        fn enabled(&self, metadata: &log::Metadata) -> bool {
            metadata.level() <= self.0
        }

        fn log(&self, record: &log::Record) {
            if self.enabled(record.metadata()) {
                eprintln!("[{} {}] {}", record.level(), record.target(), record.args());
            }
        }

        fn flush(&self) {}
    }

    let level = match std::env::var("LATTICE_GPUI_LOG").as_deref() {
        Ok("debug") => log::LevelFilter::Debug,
        Ok("info") => log::LevelFilter::Info,
        _ => log::LevelFilter::Warn,
    };
    let logger = Box::leak(Box::new(StderrLogger(level)));
    if log::set_logger(logger).is_ok() {
        log::set_max_level(level);
    }
}
