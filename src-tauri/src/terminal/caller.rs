//! Who may reach a shell: Lattice's own workspace page in a native Lattice
//! window, and nothing else.
//!
//! A shell runs anything, so the terminal commands are held to a narrower
//! caller than the rest of the command table. Tauri already refuses every app
//! command from a page that is not Lattice's own origin (the Synara and Open
//! Slide frames on their loopback ports, a sandboxed HTML preview or Agent
//! visual, whose origin is opaque): the capability grants no `remote` URLs.
//! On top of that, each terminal command checks here that it came from
//!
//! - a workspace window (`main` or `project-*`), not the hidden host window
//!   that relays a browser tab (`browser-*`), the Overleaf sign-in window or
//!   any other window Lattice opens;
//! - that window's own page, not a webview added to it;
//! - a page, and a request origin, that are Lattice's bundled frontend.
//!
//! No caller chooses what runs: the shell is the account's login shell, it
//! starts in the window's own project folder (`pinned_root`), and the page
//! only sends keystrokes, a size and an acknowledgement.

/// What a terminal command knows about where it came from.
pub(crate) struct Caller<'a> {
    pub(crate) window: &'a str,
    pub(crate) webview: &'a str,
    /// The calling page's URL.
    pub(crate) page: &'a str,
    /// The request's `Origin` header, when the engine sent one.
    pub(crate) origin: Option<&'a str>,
}

/// The origins Lattice's bundled frontend loads from: the app scheme, and in
/// a debug build the Vite dev server it is configured with.
pub(crate) fn local_origins<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<String> {
    let dev_server = cfg!(debug_assertions)
        .then(|| app.config().build.dev_url.as_ref().map(|url| url.origin().ascii_serialization()))
        .flatten();
    ["tauri://localhost".to_string(), "http://tauri.localhost".to_string()]
        .into_iter()
        .chain(dev_server)
        .collect()
}

fn origin_of(url: &str) -> Option<String> {
    let parsed = tauri::Url::parse(url).ok()?;
    let origin = parsed.origin();
    if origin.is_tuple() {
        return Some(origin.ascii_serialization());
    }
    // tauri://localhost has no tuple origin in the URL standard: compare it
    // by scheme and host instead. An opaque page (about:blank, data:) has neither.
    parsed.host_str().map(|host| format!("{}://{host}", parsed.scheme()))
}

fn is_workspace_window(label: &str) -> bool {
    label == crate::MAIN_WINDOW_LABEL
        || label.strip_prefix("project-").is_some_and(|rest| !rest.is_empty())
}

/// Refuse `caller` unless it is a workspace window's own page on Lattice's
/// frontend (see the module notes).
pub(crate) fn check(caller: &Caller<'_>, local: &[String]) -> Result<(), String> {
    let refused = |why: &str| {
        log::warn!(
            target: "lattice::terminal",
            "Refused a terminal request from {} ({}, {}): {why}",
            caller.window, caller.webview, caller.page
        );
        Err("The terminal is only available in a Lattice window.".to_string())
    };
    if !is_workspace_window(caller.window) {
        return refused("not a workspace window");
    }
    if caller.webview != caller.window {
        return refused("not the window's own page");
    }
    let is_local = |origin: Option<String>| origin.is_some_and(|origin| local.contains(&origin));
    if !is_local(origin_of(caller.page)) {
        return refused("the page is not Lattice's");
    }
    if let Some(origin) = caller.origin {
        if !is_local(Some(origin.to_string())) {
            return refused("the request came from another origin");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{check, Caller};

    fn local() -> Vec<String> {
        vec![
            "tauri://localhost".into(),
            "http://tauri.localhost".into(),
            "http://localhost:1420".into(),
        ]
    }

    fn caller<'a>(
        window: &'a str, webview: &'a str, page: &'a str, origin: Option<&'a str>,
    ) -> Caller<'a> {
        Caller { window, webview, page, origin }
    }

    #[test]
    fn a_workspace_window_on_lattice_s_own_page_may_open_a_shell() {
        for (window, page, origin) in [
            ("main", "tauri://localhost/index.html", Some("tauri://localhost")),
            ("project-2", "tauri://localhost/", None),
            ("main", "http://localhost:1420/", Some("http://localhost:1420")),
        ] {
            assert!(
                check(&caller(window, window, page, origin), &local()).is_ok(),
                "{window} {page}"
            );
        }
    }

    #[test]
    fn other_windows_webviews_pages_and_origins_are_refused() {
        let refused = [
            // The hidden host that relays a browser tab, and other windows.
            caller("browser-1", "browser-1", "tauri://localhost/", None),
            caller("overleaf-login", "overleaf-login", "https://www.overleaf.com/login", None),
            caller("project-", "project-", "tauri://localhost/", None),
            // A webview added to a workspace window.
            caller("main", "preview", "tauri://localhost/", None),
            // A workspace window that navigated away from Lattice.
            caller("main", "main", "https://evil.example/", None),
            caller("main", "main", "http://127.0.0.1:43123/", None),
            // A frame inside Lattice's page on another origin: the Synara
            // panel, an Open Slide deck, a sandboxed preview (opaque, "null").
            caller("main", "main", "tauri://localhost/", Some("http://127.0.0.1:51234")),
            caller("main", "main", "tauri://localhost/", Some("null")),
            caller("main", "main", "tauri://localhost/", Some("https://www.overleaf.com")),
        ];
        for refused in refused {
            assert!(
                check(&refused, &local()).is_err(),
                "{} {} {} {:?}",
                refused.window,
                refused.webview,
                refused.page,
                refused.origin
            );
        }
    }

    /// Every terminal command checks its caller before anything else, and no
    /// capability lets a remote page reach app commands at all.
    #[test]
    fn every_terminal_command_checks_its_caller_and_no_remote_page_is_granted() {
        let commands = include_str!("../ipc/terminal.rs");
        let bodies: Vec<&str> = commands.split("#[tauri::command]").skip(1).collect();
        assert_eq!(bodies.len(), 6);
        for body in bodies {
            let first_statement =
                body.split(") -> ").nth(1).and_then(|rest| rest.lines().nth(1)).unwrap_or_default();
            assert!(first_statement.contains("caller_window(&webview, &request)?"), "{body}");
        }
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap();
        assert!(
            capability.get("remote").is_none(),
            "a remote URL may not invoke Lattice's commands"
        );
    }
}
