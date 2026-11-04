use super::*;
use tauri::{
    test::{mock_builder, mock_context, noop_assets},
    WebviewWindowBuilder,
};

#[tauri::command]
fn private_workspace_command() -> &'static str {
    "private workspace data"
}

#[test]
fn remote_content_and_toolbar_cannot_invoke_workspace_commands() {
    let app = mock_builder()
        .invoke_handler(isolated(tauri::generate_handler![private_workspace_command]))
        .build(mock_context(noop_assets()))
        .unwrap();
    for label in ["main", "site-content-test", "site-controls-test"] {
        let webview =
            WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::default()).build().unwrap();
        let response = tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: "private_workspace_command".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::default(),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        );
        if label == "main" {
            assert_eq!(
                response.unwrap().deserialize::<String>().unwrap(),
                "private workspace data"
            );
        } else {
            assert!(response.is_err(), "{label} reached the workspace dispatcher");
        }
    }
}

#[test]
fn browser_addresses_allow_web_navigation_and_reject_local_and_script_capabilities() {
    assert_eq!(address("example.com/path").unwrap().as_str(), "https://example.com/path");
    assert!(address("http://127.0.0.1:18000/fixture").is_ok());
    for value in [
        "file:///etc/passwd",
        "tauri://localhost/index.html",
        "javascript:alert(1)",
        "data:text/html,hello",
        "https://user:secret@example.com/",
    ] {
        assert!(address(value).is_err(), "{value}");
    }
}

#[test]
fn the_trusted_toolbar_cannot_navigate_to_remote_or_another_loopback_service() {
    assert!(toolbar_address(&"tauri://localhost/browser.html?lang=en".parse().unwrap(), None));
    assert!(toolbar_address(&"http://tauri.localhost/browser.html".parse().unwrap(), None));
    let development: tauri::Url = "http://localhost:1420/".parse().unwrap();
    assert!(toolbar_address(&development.join("browser.html").unwrap(), Some(&development)));
    for value in [
        "https://example.com/browser.html",
        "http://localhost/browser.html",
        "http://localhost:18452/browser.html",
        "tauri://localhost/index.html",
    ] {
        assert!(!toolbar_address(&value.parse().unwrap(), Some(&development)), "{value}");
    }
}
