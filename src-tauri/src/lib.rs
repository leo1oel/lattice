//! Lattice's Rust host: the Tauri application shell.
//!
//! `run` wires plugins, the window lifecycle and the command table together.
//! Which project each window shows lives in `app_state`; the command handlers
//! live in `ipc`, one module per area of the app; the behaviour behind them
//! lives in the domain modules below.

mod agent_literature;
mod alphaxiv;
mod app_identity;
mod app_state;
mod browser_host;
mod chromium;
mod citation_audit;
mod citation_batch;
mod citation_health;
mod command_diagnostics;
mod commands;
mod diagnostic_logs;
mod doctor;
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
mod macos_window;
mod models;
mod native_locale;
mod openalex;
mod overleaf;
mod overleaf_rt;
mod paper_pdf_proxy;
mod papers;
mod pdf_fonts;
#[cfg(feature = "perf-lab")]
mod perf_lab;
mod presentation;
mod process_inspector;
mod project;
mod project_fs;
mod synara;
#[cfg(test)]
mod test_support;
mod tex_setup;
mod texcount;
mod texlab;
mod util;
mod web_metadata;
mod xlsx;

use app_state::AppState;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;

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
        .title("Lattice")
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
    macos_window::apply_window_background(&window, false);
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
    app.state::<chromium::ChromiumRuntime>().shutdown();
    app.state::<synara::SynaraRuntime>().shutdown();
    app.state::<presentation::PresentationRuntime>().shutdown();
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
        let state = window.state::<AppState>();
        state.release_window(window.label());
        let browser = window.state::<browser_host::BrowserHost>();
        browser.activate_source(window.label(), &state);
        browser.hide_desktop_shell_if_browser_only(window.app_handle());
        state.retire_unused_projects();
    }
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    log::info!(target: "lattice::app", "Lattice {} starting", app.package_info().version);
    #[cfg(feature = "perf-lab")]
    {
        perf_lab::trace("rust:setup-start");
        perf_lab::disable_app_nap();
    }
    app.manage(AppState::from_environment());
    app.manage(browser_host::BrowserHost::default());
    app.manage(chromium::ChromiumRuntime::default());
    app.manage(synara::SynaraRuntime::new(app)?);
    app.manage(presentation::PresentationRuntime::new(app)?);
    let background = browser_host_launch();
    let chromium_packaged =
        !background && app.state::<chromium::ChromiumRuntime>().is_packaged(app.handle());
    let browser_start =
        app.state::<browser_host::BrowserHost>().start(app.handle(), chromium_packaged);
    let chromium_ready = chromium_packaged && browser_start.is_ok();
    if let Err(reason) = &browser_start {
        if background {
            return Err(std::io::Error::other(reason.clone()).into());
        }
        // WK can operate without the optional loopback service. Do
        // not launch Chromium after a bind failure: it could attach to
        // whichever process owns the fixed port instead of this native
        // owner, so this exceptional launch falls back to WK instead.
        log::warn!(target: "lattice::browser", "{reason}");
    }
    // Browser access after login was removed: the local address now lives
    // exactly as long as Lattice runs. The login item older builds installed
    // launches `--browser-host` at every login, so switch it off here once.
    // TODO(next release): drop this cleanup, the autostart plugin and
    // browser_host/takeover.rs together.
    if app.autolaunch().is_enabled().unwrap_or(false) {
        if let Err(error) = app.autolaunch().disable() {
            log::warn!(target: "lattice::browser", "could not remove the browser login item: {error}");
        }
    }
    if background || chromium_ready {
        app.state::<browser_host::BrowserHost>()
            .keep_resident(app.handle())
            .map_err(std::io::Error::other)?;
    }
    // After an update changed a tool pin, this rebuilds the uvx
    // environment now instead of during the user's first import.
    tauri::async_runtime::spawn_blocking(commands::prewarm_literature_tools);
    macos_window::clear_launch_quarantine();
    macos_window::install_magnify_monitor(app.handle().clone());
    macos_window::install_copy_shortcut_monitor(app.handle().clone());
    // The main window is `create: false` in tauri.conf.json, so no window
    // exists yet: a desktop launch builds it through `workspace_window`.
    if background || chromium_ready {
        app.handle().set_activation_policy(tauri::ActivationPolicy::Accessory)?;
        if chromium_ready {
            app.state::<chromium::ChromiumRuntime>()
                .launch(app.handle())
                .map_err(std::io::Error::other)?;
        }
    } else {
        show_desktop_window(app.handle()).map_err(std::io::Error::other)?;
    }
    Ok(())
}

/// Dock click with no window showing: bring back whichever surface this
/// launch uses — the browser entry, packaged Chromium, or the desktop window.
fn reopen(app: &AppHandle) {
    let browser = app.state::<browser_host::BrowserHost>();
    match browser.reopen_entry(app) {
        Ok(true) => {}
        Ok(false) => {
            let chromium = app.state::<chromium::ChromiumRuntime>();
            let opened = chromium.open_url("http://127.0.0.1:18452/").unwrap_or_else(|reason| {
                log::error!(target: "lattice::chromium", "could not reopen Lattice: {reason}");
                false
            });
            if !opened {
                if let Err(reason) = show_desktop_window(app) {
                    log::error!(target: "lattice::app", "could not reopen Lattice: {reason}");
                }
            }
        }
        Err(reason) => {
            log::error!(target: "lattice::browser", "could not reopen browser entry: {reason}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    app_identity::init(&context.config().identifier);
    process_inspector::run_if_requested();
    if agent_literature::run_cli() {
        return;
    }
    // Panics after the log plugin installs its logger land in the log file;
    // earlier ones are dropped silently by the `log` crate, which is fine.
    std::panic::set_hook(Box::new(|info| {
        log::error!(target: "lattice::panic", "{info}");
    }));
    let app = tauri::Builder::default()
        // Registered first so init-time logs from the other plugins are captured.
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("lattice".to_string()),
                    }),
                    #[cfg(debug_assertions)]
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                ])
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                .max_file_size(2 * 1024 * 1024)
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        // In-app auto-update (checks GitHub Releases, verifies with the updater key).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::Builder::new().arg(BROWSER_HOST_ARG).build())
        // Remember the window's size + position across launches.
        // The browser bridge is deliberately hidden. The plugin's default
        // restore path shows every newly created dynamic window, even when its
        // builder says `visible(false)`, so bridge windows must stay outside
        // this lifecycle entirely.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filter(|label| {
                    !label.starts_with("browser-") && label != browser_host::SERVICE_WINDOW_LABEL
                })
                .build(),
        )
        .on_window_event(on_window_event)
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
            perf_lab::perf_wheel,
            #[cfg(feature = "perf-lab")]
            perf_lab::perf_mouse,
            ipc::workspace::create_project,
            ipc::workspace::open_tutorial_project,
            ipc::workspace::initial_project,
            ipc::workspace::open_project,
            ipc::workspace::import_project_zip,
            ipc::workspace::export_project_zip,
            ipc::workspace::refresh_project,
            ipc::workspace::update_project_manifest,
            ipc::workspace::set_project_spelling_words,
            ipc::workspace::watch_project,
            ipc::windows::open_project_window,
            ipc::windows::open_in_browser,
            ipc::windows::return_to_desktop,
            ipc::windows::get_app_log_dir,
            ipc::windows::open_app_log_dir,
            ipc::windows::restart_after_update,
            ipc::windows::set_window_background,
            ipc::windows::set_native_locale,
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
            ipc::files::import_project_sources,
            ipc::files::import_clipboard_image,
            ipc::files::read_project_asset,
            ipc::files::read_project_asset_range,
            ipc::files::save_project_pdf,
            ipc::files::write_project_bytes,
            ipc::files::prepare_latex_figure,
            ipc::files::save_xlsx,
            ipc::files::list_editor_comments,
            ipc::files::save_editor_comments,
            ipc::search::search_project,
            ipc::search::preview_replace_in_project,
            ipc::search::replace_in_project,
            ipc::search::find_symbol_occurrences,
            ipc::search::rename_symbol,
            ipc::search::list_references,
            ipc::search::list_unused_symbols,
            ipc::search::list_todos,
            ipc::search::count_project_words,
            ipc::bibliography::list_citations,
            ipc::bibliography::read_bib_entry,
            ipc::bibliography::save_bib_entry,
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
            ipc::papers::paper_pdf_preview_url,
            ipc::papers::fetch_web_reference,
            ipc::papers::list_papers,
            ipc::papers::search_paper_library,
            ipc::papers::read_paper,
            ipc::papers::read_paper_blog_local,
            ipc::build::build_project,
            ipc::build::compile_repair,
            ipc::build::abort_build,
            ipc::build::clean_project,
            ipc::build::read_compiled_pdf,
            ipc::build::save_compiled_pdf,
            ipc::build::synctex_edit,
            ipc::build::synctex_view,
            ipc::build::run_doctor,
            ipc::build::harper_lint,
            ipc::build::format_latex,
            ipc::build::texlab_diagnostics,
            ipc::build::texlab_completion,
            ipc::build::texlab_hover,
            ipc::build::texlab_definition,
            ipc::build::start_tex_install,
            ipc::build::start_tex_dependency_install,
            ipc::git::git_status,
            ipc::git::git_user_name,
            ipc::git::git_init,
            ipc::git::git_log,
            ipc::git::git_show_diff,
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
            presentation::presentation_ensure_ready,
            presentation::presentation_release,
            presentation::presentation_refresh_native_workspace,
        ])
        .build(context)
        .expect("error while running tauri application");
    app.run(|app_handle, event| match event {
        tauri::RunEvent::Exit => shutdown_child_runtimes(app_handle),
        tauri::RunEvent::Reopen { has_visible_windows: false, .. } => reopen(app_handle),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::is_open_slide_presenter_url;

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
