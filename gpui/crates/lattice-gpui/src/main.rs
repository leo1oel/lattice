//! Lattice's LaTeX writing flow on GPUI: a project folder in a file tree, Zed's
//! editor with LaTeX highlighting and search, a PDFium preview, latexmk
//! builds with diagnostics, all in GPUI Kit's dockable panels.
//!
//! Usage: `lattice-gpui [PROJECT_DIR]`; scripted runs (macOS):
//! `lattice-gpui PROJECT_DIR --scenario e2e|perf|ime --out RESULT.json`.

mod app;
mod assets;
mod build_panel;
mod editor_panel;
mod file_tree;
mod latex;
#[cfg(target_os = "macos")]
mod native;
mod paint_probe;
mod pdf;
#[cfg(target_os = "macos")]
mod scenario;
mod shell;

fn main() {
    init_logging();
    #[cfg(target_os = "macos")]
    let (root, scenario) = scenario::parse_args();
    #[cfg(not(target_os = "macos"))]
    let root = std::env::args_os().nth(1).map(std::path::PathBuf::from);

    gpui_kit::application()
        .with_assets(assets::Assets)
        .run(move |cx| {
            app::init(cx);
            // A scripted measurement leaves the user's frontmost app alone.
            #[cfg(target_os = "macos")]
            let activate = scenario.is_none();
            #[cfg(not(target_os = "macos"))]
            let activate = true;
            match shell::Shell::open_window(root, cx) {
                Ok((_window, _shell)) =>
                {
                    #[cfg(target_os = "macos")]
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
