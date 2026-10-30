//! Lattice's Rust host: the Tauri application shell.
//!
//! `run` wires plugins, the window lifecycle and the command table together.
//! Which project each window shows lives in `app_state`; most command handlers
//! live in `ipc`, one module per area of the app, while a few self-contained
//! features (link previews, literature credentials, diagnostic logs, browser
//! dialogs, the PDF copy text, Synara, Open Slide and the perf lab) register
//! their own; the behaviour behind them lives in the domain modules below.

mod agent_literature;
mod alphaxiv;
mod app_identity;
mod app_state;
mod browser_host;
mod citation_audit;
mod citation_batch;
mod citation_health;
mod command_diagnostics;
mod commands;
mod diagnostic_logs;
mod doctor;
mod export;
mod firecrawl;
mod format_latex;
mod fs_watch;
mod fts;
mod git;
mod harper;
mod http;
mod ipc;
mod latex;
mod link_preview;
mod literature;
mod literature_credentials;
mod literature_service;
mod live_preview;
mod macos_window;
mod models;
mod native_locale;
mod openalex;
mod overleaf;
mod overleaf_rt;
mod paper_pdf_proxy;
mod papers;
mod pdf_fonts;
mod pdf_pages;
#[cfg(feature = "perf-lab")]
mod perf_lab;
mod presentation;
mod process_inspector;
mod project;
mod project_fs;
mod research_env;
mod review_pdf;
mod sidecar;
mod synara;
mod terminal;
#[cfg(test)]
mod test_support;
mod tex_setup;
mod texcount;
mod texlab;
mod util;
mod web_metadata;
mod wide_event;

use app_state::AppState;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow, WebviewWindowBuilder};

/// Label Tauri gives the window declared in tauri.conf.json.
const MAIN_WINDOW_LABEL: &str = "main";
const BROWSER_HOST_ARG: &str = "--browser-host";

fn browser_host_launch() -> bool {
    std::env::args_os().any(|argument| argument == BROWSER_HOST_ARG)
}

// Presenter and projection synchronize through BroadcastChannel, so this must
// remain a Wry child window sharing its opener's WebView configuration. An
// external browser can load the notes but cannot stay linked to the slideshow.
fn is_open_slide_presenter_url(url: &tauri::Url) -> bool {
    let query =
        |name: &str| url.query_pairs().find_map(|(key, value)| (key == name).then_some(value));
    let presenter_path = |next: &str| {
        next.strip_prefix("/s/")
            .and_then(|path| path.strip_suffix("/presenter"))
            .is_some_and(|deck_id| !deck_id.is_empty() && !deck_id.contains('/'))
    };
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some()
        && url.path() == "/__lattice/bootstrap"
        && query("token").is_some_and(|token| !token.is_empty())
        && query("next").is_some_and(|next| presenter_path(&next))
}

/// The traffic lights sit over the web content, which draws its own title bar.
fn overlay_title_bar<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .accept_first_mouse(true)
}

/// A desktop workspace window: the launch window (`center`) or a project
/// window, which the window-state plugin places. The main window in
/// tauri.conf.json has `create: false` so it gets this same constrained popup
/// policy.
fn workspace_window(app: &AppHandle, label: &str, center: bool) -> tauri::Result<WebviewWindow> {
    let builder = WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::default())
        .title(app.package_info().name.as_str())
        .inner_size(1440.0, 900.0)
        .min_inner_size(640.0, 680.0)
        .background_color(tauri::window::Color(0xF7, 0xF7, 0xF6, 0xFF))
        .on_new_window(|url, _| {
            if is_open_slide_presenter_url(&url) {
                tauri::webview::NewWindowResponse::Allow
            } else {
                tauri::webview::NewWindowResponse::Deny
            }
        });
    let builder = if center { builder.center() } else { builder };
    let window = overlay_title_bar(builder).build()?;
    macos_window::install_traffic_light_alignment(&window);
    macos_window::apply_window_material(&window, &macos_window::WindowMaterial::at_launch());
    macos_window::render_at_display_refresh_rate(&window);
    #[cfg(feature = "perf-lab")]
    perf_lab::tune_wkwebview(&window);
    Ok(window)
}

fn show_desktop_window(app: &AppHandle) -> Result<(), String> {
    app.set_activation_policy(tauri::ActivationPolicy::Regular)
        .map_err(|error| format!("Could not show Lattice in the Dock: {error}"))?;
    let window = match app.get_webview_window(MAIN_WINDOW_LABEL) {
        Some(window) => {
            window.show().map_err(|error| format!("Could not show the Lattice window: {error}"))?;
            window
        }
        None => workspace_window(app, MAIN_WINDOW_LABEL, true)
            .map_err(|error| format!("Could not create the Lattice window: {error}"))?,
    };
    let _ = window.set_focus();
    Ok(())
}

fn shutdown_child_runtimes(app: &AppHandle) {
    app.state::<synara::SynaraRuntime>().shutdown();
    app.state::<presentation::PresentationRuntime>().shutdown();
    app.state::<AppState>().stop_all_live_previews();
    app.state::<AppState>().terminals.close_all_and_wait();
}

fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::Focused(is_focused) = event {
        macos_window::set_window_focused(window.label(), *is_focused);
    }
    // A closed window's project must stop being anyone's project, or
    // its LaTeX language server and Overleaf socket outlive the window
    // and a later window reusing the label inherits a stale binding.
    if matches!(event, tauri::WindowEvent::Destroyed) {
        macos_window::clear_pdf_copy_text(window.label());
        macos_window::forget_window_material(window.label());
        // Its page never ran the cleanup that releases a deck's lease, which
        // would otherwise keep every other project's deck from opening.
        window.state::<presentation::PresentationRuntime>().forget_page(window.label());
        let state = window.state::<AppState>();
        state.release_window(window.label());
        let browser = window.state::<browser_host::BrowserHost>();
        browser.activate_source(window.label(), &state);
        browser.hide_desktop_shell_if_browser_only(window.app_handle());
        state.retire_unused_projects();
    }
}

/// WebKit reports `Started` when a main-frame navigation commits (a reload,
/// or the first load): the page it replaced never ran its cleanup, so its
/// deck leases are released and its live preview stopped here.
fn on_page_load<R: Runtime>(
    webview: &tauri::Webview<R>, payload: &tauri::webview::PageLoadPayload<'_>,
) {
    if payload.event() == tauri::webview::PageLoadEvent::Started {
        if let Some(runtime) = webview.try_state::<presentation::PresentationRuntime>() {
            runtime.forget_page(webview.label());
        }
        // Nothing is left to draw a live preview that page had started, or
        // the terminals it had open.
        if let Some(state) = webview.try_state::<AppState>() {
            if let Ok(Some(root)) = state.root_for(webview.label()) {
                state.project(&root).stop_live_preview();
            }
            state.terminals.close_window(webview.label());
        }
    }
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    log::info!(target: "lattice::app", "Lattice {} starting", app.package_info().version);
    #[cfg(feature = "perf-lab")]
    perf_lab::disable_app_nap();
    app.manage(AppState::from_environment());
    app.manage(browser_host::BrowserHost::default());
    app.manage(synara::SynaraRuntime::new(app)?);
    app.manage(presentation::PresentationRuntime::new(app)?);
    let background = browser_host_launch();
    if let Err(reason) = app.state::<browser_host::BrowserHost>().start(app.handle()) {
        if background {
            return Err(std::io::Error::other(reason).into());
        }
        // A desktop launch works without the optional loopback service; only
        // Open in browser needs it, and that reports the failure again.
        log::warn!(target: "lattice::browser", "{reason}");
    }
    if background {
        app.state::<browser_host::BrowserHost>().keep_resident();
    }
    // After an update changed a tool pin, this rebuilds the uvx
    // environment now instead of during the user's first import.
    tauri::async_runtime::spawn_blocking(commands::prewarm_literature_tools);
    macos_window::clear_launch_quarantine();
    macos_window::install_magnify_monitor(app.handle().clone());
    macos_window::install_copy_shortcut_monitor(app.handle().clone());
    // The main window is `create: false` in tauri.conf.json, so no window
    // exists yet: a desktop launch builds it through `workspace_window`.
    if background {
        app.handle().set_activation_policy(tauri::ActivationPolicy::Accessory)?;
    } else {
        show_desktop_window(app.handle()).map_err(std::io::Error::other)?;
    }
    Ok(())
}

/// Dock click with no window showing: bring back whichever surface this
/// launch uses — the browser entry or the desktop window.
fn reopen(app: &AppHandle) {
    let browser = app.state::<browser_host::BrowserHost>();
    match browser.reopen_entry(app) {
        Ok(true) => {}
        Ok(false) => {
            if let Err(reason) = show_desktop_window(app) {
                log::error!(target: "lattice::app", "could not reopen Lattice: {reason}");
            }
        }
        Err(reason) => {
            log::error!(target: "lattice::browser", "could not reopen browser entry: {reason}");
        }
    }
}

/// Crates that log a line per request, frame or file event at debug level.
const NOISY_DEPENDENCIES: &[&str] = &[
    "tao",
    "wry",
    "tauri",
    "reqwest",
    "hyper",
    "hyper_util",
    "h2",
    "rustls",
    "tungstenite",
    "tokio_tungstenite",
    "axum",
    "tower",
    "mio",
    "notify",
    "globset",
    "ignore",
    "html5ever",
    "selectors",
];

/// The log level: `LATTICE_LOG` (error, warn, info, debug or trace) when set,
/// else debug in development builds and info in release builds.
fn log_level(setting: Option<&str>) -> log::LevelFilter {
    let default =
        if cfg!(debug_assertions) { log::LevelFilter::Debug } else { log::LevelFilter::Info };
    setting.and_then(|value| value.trim().parse().ok()).unwrap_or(default)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    // The process inspector is a bare helper with no identity of its own, so it
    // runs even from a binary whose flavor and config disagree (`cargo test`
    // with LATTICE_FLAVOR=beta builds one).
    process_inspector::run_if_requested();
    app_identity::init(&context.config().identifier);
    http::install_tls_provider();
    if agent_literature::run_cli() || research_env::run_cli() {
        return;
    }
    // Panics after the log plugin installs its logger land in the log file;
    // earlier ones are dropped silently by the `log` crate, which is fine.
    std::panic::set_hook(Box::new(|info| {
        log::error!(target: "lattice::panic", "{info}");
    }));
    // Operation spans become wide events written through the log plugin below.
    wide_event::init();
    let level = log_level(std::env::var("LATTICE_LOG").ok().as_deref());
    let mut log_plugin = tauri_plugin_log::Builder::new()
        .targets([
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                file_name: Some("lattice".to_string()),
            }),
            #[cfg(debug_assertions)]
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
        ])
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
        .max_file_size(2 * 1024 * 1024)
        .level(level)
        .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal);
    // Debug is for Lattice's own lines. The window, network and file-watch
    // crates would bury them, so only `trace` lets those through below info.
    if level < log::LevelFilter::Trace {
        for chatty in NOISY_DEPENDENCIES {
            log_plugin = log_plugin.level_for(*chatty, level.min(log::LevelFilter::Info));
        }
    }
    let app = tauri::Builder::default()
        // Registered first so init-time logs from the other plugins are captured.
        .plugin(log_plugin.build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        // In-app auto-update (checks GitHub Releases, verifies with the updater key).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Remember the window's size + position across launches.
        // The browser bridge is deliberately hidden. The plugin's default
        // restore path shows every newly created dynamic window, even when its
        // builder says `visible(false)`, so bridge windows must stay outside
        // this lifecycle entirely.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filter(|label| !label.starts_with("browser-"))
                .build(),
        )
        .on_window_event(on_window_event)
        .on_page_load(on_page_load)
        .on_menu_event(|app, event| native_locale::handle_menu_event(app, &event))
        .setup(setup)
        .invoke_handler(tauri::generate_handler![
            #[cfg(feature = "perf-lab")]
            perf_lab::perf_config,
            #[cfg(feature = "perf-lab")]
            perf_lab::perf_now,
            #[cfg(feature = "perf-lab")]
            perf_lab::perf_echo,
            #[cfg(feature = "perf-lab")]
            perf_lab::perf_bytes,
            #[cfg(feature = "perf-lab")]
            perf_lab::perf_texlab_probe,
            #[cfg(feature = "perf-lab")]
            perf_lab::perf_write,
            #[cfg(feature = "perf-lab")]
            perf_lab::perf_emit,
            #[cfg(feature = "perf-lab")]
            perf_lab::perf_magnify,
            #[cfg(feature = "perf-lab")]
            perf_lab::perf_focus,
            #[cfg(feature = "perf-lab")]
            perf_lab::perf_key,
            #[cfg(feature = "perf-lab")]
            perf_lab::perf_shortcut,
            #[cfg(feature = "perf-lab")]
            perf_lab::perf_edit_menu,
            #[cfg(feature = "perf-lab")]
            perf_lab::perf_wheel,
            #[cfg(feature = "perf-lab")]
            perf_lab::perf_mouse,
            ipc::workspace::create_project,
            ipc::workspace::list_local_templates,
            ipc::workspace::inspect_template_source,
            ipc::workspace::save_local_template,
            ipc::workspace::open_tutorial_project,
            ipc::workspace::initial_project,
            ipc::workspace::open_project,
            ipc::workspace::import_project_zip,
            ipc::workspace::export_project_zip,
            ipc::workspace::check_arxiv_package,
            ipc::workspace::cancel_arxiv_check,
            ipc::workspace::export_arxiv_package,
            ipc::workspace::refresh_project,
            ipc::workspace::update_project_manifest,
            ipc::workspace::set_project_deadline,
            ipc::workspace::set_project_spelling_words,
            ipc::workspace::set_project_grammar_ignores,
            ipc::workspace::set_submission_items,
            ipc::workspace::watch_project,
            ipc::windows::open_project_window,
            ipc::windows::open_in_browser,
            ipc::windows::return_to_desktop,
            ipc::windows::get_app_log_dir,
            ipc::windows::open_app_log_dir,
            ipc::windows::restart_after_update,
            ipc::windows::set_window_material,
            ipc::windows::set_native_locale,
            ipc::windows::native_edit_history,
            ipc::windows::align_traffic_lights,
            ipc::windows::sample_screen_color,
            ipc::files::list_project_tree_with_hidden,
            ipc::files::stat_project_file,
            ipc::files::read_project_file,
            ipc::files::write_project_file,
            ipc::files::create_project_entry,
            ipc::files::create_open_slide_deck,
            ipc::files::delete_project_entry,
            ipc::files::rename_project_entry,
            ipc::files::move_project_entry,
            ipc::files::import_project_assets,
            ipc::files::read_agent_composer_files,
            ipc::files::import_project_files,
            ipc::files::choose_import_entries,
            ipc::files::import_project_sources,
            ipc::files::import_clipboard_image,
            ipc::files::read_project_asset,
            ipc::files::read_project_asset_range,
            ipc::files::save_project_pdf,
            ipc::files::write_project_bytes,
            ipc::files::prepare_latex_figure,
            ipc::files::save_xlsx,
            ipc::files::save_agent_visual,
            ipc::files::save_source_copy,
            ipc::files::list_annotations,
            ipc::files::save_annotations,
            ipc::files::save_annotation_round,
            ipc::files::read_annotation_round,
            ipc::files::restore_annotation_round,
            ipc::search::search_project,
            ipc::search::preview_replace_in_project,
            ipc::search::replace_in_project,
            ipc::search::find_symbol_occurrences,
            ipc::search::rename_symbol,
            ipc::search::list_references,
            ipc::search::list_unused_symbols,
            ipc::search::list_citation_usages,
            ipc::search::list_todos,
            ipc::search::count_project_words,
            ipc::bibliography::list_citations,
            ipc::bibliography::read_bib_entry,
            ipc::bibliography::save_bib_entry,
            ipc::bibliography::read_linked_bibliography,
            ipc::bibliography::read_bibliography_source,
            ipc::bibliography::save_linked_bibliography,
            ipc::bibliography::unlink_bibliography,
            ipc::bibliography::resolve_citation_query,
            ipc::bibliography::remove_reference,
            ipc::bibliography::agent_bibliography_mutation,
            ipc::bibliography::bibliography_audit_scan,
            ipc::bibliography::bibliography_audit_report_load,
            ipc::bibliography::bibliography_audit_report_save,
            ipc::bibliography::bibliography_audit_batch,
            ipc::bibliography::bibliography_audit_entry,
            ipc::bibliography::bibliography_audit_apply,
            ipc::papers::search_literature,
            ipc::papers::import_reference,
            ipc::papers::cancel_reference_import,
            ipc::papers::fetch_paper,
            ipc::papers::cancel_paper_fetch,
            ipc::papers::paper_pdf_preview_url,
            ipc::papers::fetch_web_reference,
            ipc::papers::list_papers,
            ipc::papers::refresh_citation_health,
            ipc::papers::search_paper_library,
            ipc::papers::read_paper,
            ipc::papers::read_paper_blog_local,
            ipc::build::build_project,
            ipc::build::compile_repair,
            ipc::build::agent_text_task,
            ipc::build::export_changes_pdf,
            ipc::build::abort_build,
            ipc::build::clean_project,
            ipc::build::read_compiled_pdf,
            ipc::build::save_compiled_pdf,
            ipc::build::pdf_page_signatures,
            ipc::build::save_review_pdf,
            ipc::build::synctex_edit,
            ipc::build::synctex_view,
            ipc::build::synctex_body_pages,
            ipc::build::synctex_heading_pages,
            ipc::build::run_doctor,
            ipc::build::submission_review,
            ipc::build::harper_lint,
            ipc::build::harper_rules,
            ipc::build::format_latex,
            ipc::build::texlab_diagnostics,
            ipc::build::texlab_completion,
            ipc::build::texlab_hover,
            ipc::build::texlab_definition,
            ipc::build::start_tex_install,
            ipc::build::start_tex_dependency_install,
            ipc::live_preview::live_preview_status,
            ipc::live_preview::live_preview_install,
            ipc::live_preview::live_preview_remove,
            ipc::live_preview::live_preview_start,
            ipc::live_preview::live_preview_stop,
            ipc::live_preview::live_preview_send,
            ipc::live_preview::live_preview_read_file,
            ipc::git::git_status,
            ipc::git::git_user_name,
            ipc::git::git_init,
            ipc::git::git_log,
            ipc::git::git_show_diff,
            ipc::git::git_compare_files,
            ipc::git::git_compare_file,
            ipc::git::git_restore_file,
            ipc::git::git_restore_project,
            ipc::git::git_auto_commit,
            ipc::history::list_history,
            ipc::history::get_history_entry,
            ipc::history::revert_transaction,
            ipc::history::revert_history_file,
            ipc::history::delete_history_entry,
            ipc::overleaf::overleaf_status,
            ipc::overleaf::overleaf_begin_login,
            ipc::overleaf::overleaf_poll_login,
            ipc::overleaf::overleaf_disconnect,
            ipc::overleaf::overleaf_list_projects,
            ipc::overleaf::overleaf_clone_target,
            ipc::overleaf::overleaf_clone_project,
            ipc::overleaf::overleaf_publish_project,
            ipc::overleaf::overleaf_link,
            ipc::overleaf::overleaf_chat_messages,
            ipc::overleaf::overleaf_send_chat_message,
            ipc::overleaf::overleaf_set_permission,
            ipc::overleaf::overleaf_history_updates,
            ipc::overleaf::overleaf_history_diff,
            ipc::overleaf::overleaf_history_files,
            ipc::overleaf::overleaf_history_revert,
            ipc::overleaf::overleaf_history_restore_file,
            ipc::overleaf::overleaf_history_add_label,
            ipc::overleaf::overleaf_history_delete_label,
            ipc::overleaf::overleaf_accept_changes,
            ipc::overleaf::overleaf_change_authors,
            ipc::overleaf::overleaf_delete_entity,
            ipc::overleaf::overleaf_threads,
            ipc::overleaf::overleaf_comment_anchors,
            ipc::overleaf::overleaf_edit_message,
            ipc::overleaf::overleaf_delete_message,
            ipc::overleaf::overleaf_reply_to_thread,
            ipc::overleaf::overleaf_resolve_thread,
            ipc::overleaf::overleaf_delete_thread,
            ipc::overleaf::overleaf_preview,
            ipc::overleaf::overleaf_set_paused,
            ipc::overleaf::overleaf_probe,
            ipc::overleaf::overleaf_sync,
            ipc::overleaf_realtime::overleaf_rt_connect,
            ipc::overleaf_realtime::overleaf_rt_disconnect,
            ipc::overleaf_realtime::overleaf_rt_join_doc,
            ipc::overleaf_realtime::overleaf_rt_leave_doc,
            ipc::overleaf_realtime::overleaf_rt_connected_users,
            ipc::overleaf_realtime::overleaf_rt_update_position,
            ipc::overleaf_realtime::overleaf_rt_send_ops,
            ipc::overleaf_realtime::overleaf_rt_doc_ranges,
            ipc::overleaf_realtime::overleaf_rt_send_comment,
            ipc::overleaf_realtime::overleaf_reject_changes,
            link_preview::link_preview,
            literature_credentials::get_literature_credentials,
            literature_credentials::set_literature_credential,
            literature_credentials::set_literature_contact,
            literature_credentials::test_literature_credential,
            diagnostic_logs::collect_diagnostic_logs,
            browser_host::dialogs::browser_dialog_open,
            browser_host::dialogs::browser_dialog_save,
            macos_window::set_pdf_copy_text,
            synara::synara_ensure_ready,
            synara::synara_open_skills_folder,
            synara::synara_open_log_folder,
            presentation::presentation_ensure_ready,
            presentation::presentation_release,
            presentation::presentation_refresh_native_workspace,
            ipc::terminal::terminal_open,
            ipc::terminal::terminal_write,
            ipc::terminal::terminal_resize,
            ipc::terminal::terminal_ack,
            ipc::terminal::terminal_running_command,
            ipc::terminal::terminal_close,
        ])
        .build(context)
        .expect("error while running tauri application");
    app.run(|app_handle, event| match event {
        tauri::RunEvent::Exit => shutdown_child_runtimes(app_handle),
        tauri::RunEvent::Reopen { has_visible_windows: false, .. } => reopen(app_handle),
        // `code` is None only when the last window closed.
        tauri::RunEvent::ExitRequested { code: None, api, .. }
            if app_handle.state::<browser_host::BrowserHost>().is_resident() =>
        {
            api.prevent_exit()
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::{is_open_slide_presenter_url, log_level};

    #[test]
    fn lattice_log_overrides_the_build_default_level() {
        assert_eq!(log_level(Some("debug")), log::LevelFilter::Debug);
        assert_eq!(log_level(Some(" WARN ")), log::LevelFilter::Warn);
        let default =
            if cfg!(debug_assertions) { log::LevelFilter::Debug } else { log::LevelFilter::Info };
        assert_eq!(log_level(Some("verbose")), default);
        assert_eq!(log_level(None), default);
    }

    #[test]
    fn only_authenticated_loopback_presenter_pages_can_open_popup_windows() {
        let allowed: tauri::Url = "http://127.0.0.1:43123/__lattice/bootstrap?token=session-secret&next=%2Fs%2Ftalk%2Fpresenter"
            .parse()
            .unwrap();
        assert!(is_open_slide_presenter_url(&allowed));

        for rejected in [
            "https://example.com/__lattice/bootstrap?token=session-secret&next=%2Fs%2Ftalk%2Fpresenter",
            "http://127.0.0.1:43123/__lattice/bootstrap?next=%2Fs%2Ftalk%2Fpresenter",
            "http://127.0.0.1:43123/__lattice/bootstrap?token=session-secret&next=%2Fs%2Ftalk",
            "http://127.0.0.1:43123/__lattice/bootstrap?token=session-secret&next=%2Fsettings",
        ] {
            assert!(!is_open_slide_presenter_url(&rejected.parse().unwrap()), "{rejected}");
        }
    }
}
