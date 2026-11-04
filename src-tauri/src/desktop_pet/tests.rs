use super::{activity, package, Config, DesktopPet};
use std::{fs, sync::Mutex};

fn folder() -> crate::test_support::TempDir {
    crate::test_support::TempDir::new("desktop-pet")
}
fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes
}
fn package_at(root: &std::path::Path, version: Option<u8>, image: &str) -> std::path::PathBuf {
    let mut manifest =
        serde_json::json!({ "displayName": "Angry sample", "spritesheetPath": image });
    if let Some(version) = version {
        manifest["spriteVersionNumber"] = version.into();
    }
    let path = root.join("pet.json");
    fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    path
}

#[test]
fn imports_legacy_and_v2_packages_into_owned_artwork() {
    let dir = folder();
    fs::write(dir.as_ref().join("sprite.png"), png(1536, 1872)).unwrap();
    let legacy = package::import(&package_at(dir.as_ref(), None, "sprite.png")).unwrap();
    assert_eq!(legacy.version, 1);
    assert_eq!(legacy.name, "Angry sample");
    let storage = DesktopPet {
        config: Mutex::new(Config::default()),
        path: dir.as_ref().join("settings.json"),
        launches: Mutex::default(),
    };
    storage.save(Config { enabled: true, pet: Some(legacy), locale: "en".into() }).unwrap();
    // Once imported, removing the source never makes the saved pet disappear.
    fs::remove_file(dir.as_ref().join("sprite.png")).unwrap();
    let saved: Config = serde_json::from_slice(&fs::read(&storage.path).unwrap()).unwrap();
    assert!(saved.enabled);
    assert!(!saved.pet.unwrap().image.is_empty());
    fs::write(dir.as_ref().join("sprite.png"), png(1536, 2288)).unwrap();
    assert_eq!(
        package::import(&package_at(dir.as_ref(), Some(2), "sprite.png")).unwrap().version,
        2
    );
}

#[test]
fn rejects_wrong_layout_active_formats_and_outside_paths_without_replacing_the_pet() {
    let dir = folder();
    fs::write(dir.as_ref().join("sprite.png"), png(100, 100)).unwrap();
    assert!(package::import(&package_at(dir.as_ref(), Some(1), "sprite.png"))
        .unwrap_err()
        .contains("1536"));
    fs::write(dir.as_ref().join("sprite.svg"), "<svg onload='alert(1)'/>").unwrap();
    assert!(package::import(&package_at(dir.as_ref(), Some(1), "sprite.svg")).is_err());
    assert!(package::import(&package_at(dir.as_ref(), Some(3), "sprite.png")).is_err());
    let outside = folder();
    fs::write(outside.as_ref().join("sprite.png"), png(1536, 1872)).unwrap();
    assert!(package::import(&package_at(
        dir.as_ref(),
        Some(1),
        outside.as_ref().join("sprite.png").to_str().unwrap()
    ))
    .unwrap_err()
    .contains("inside"));
}

#[cfg(unix)]
#[test]
fn does_not_follow_a_spritesheet_symlink_out_of_the_selected_package() {
    let dir = folder();
    let outside = folder();
    let image = outside.as_ref().join("sprite.png");
    fs::write(&image, png(1536, 1872)).unwrap();
    std::os::unix::fs::symlink(image, dir.as_ref().join("sprite.png")).unwrap();
    assert!(package::import(&package_at(dir.as_ref(), None, "sprite.png")).is_err());
}

#[test]
fn parses_lossless_webp_used_by_existing_codex_pets() {
    let dir = folder();
    let width = 1536u32;
    let height = 1872u32;
    let mut image = b"RIFF\0\0\0\0WEBPVP8L\0\0\0\0\x2f".to_vec();
    image.extend_from_slice(&((width - 1) | ((height - 1) << 14)).to_le_bytes());
    fs::write(dir.as_ref().join("sprite.webp"), image).unwrap();
    let pet = package::import(&package_at(dir.as_ref(), None, "sprite.webp")).unwrap();
    assert_eq!(pet.mime, "image/webp");
}

#[test]
fn pet_state_tracks_real_builds_ahead_of_agent_turns_then_returns_to_idle() {
    assert_eq!(activity(0, 0), "idle");
    assert_eq!(activity(0, 2), "working");
    assert_eq!(activity(1, 2), "building");
    assert_eq!(activity(0, 2), "working");
    assert_eq!(activity(0, 0), "idle");
}

#[test]
fn repeated_enable_requests_share_readiness_and_a_failed_load_can_be_retried() {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
    runtime.block_on(async {
        let mut launches = super::launch::Launches::default();
        let mut first = launches.begin();
        let mut duplicate = launches.begin();
        assert_eq!(first.generation, duplicate.generation);
        assert!(launches.loading(&first.generation));
        assert!(launches.finish(&first.generation, Ok(())));
        assert_eq!(first.wait().await, Ok(()));
        assert_eq!(duplicate.wait().await, Ok(()));
        assert!(!launches.finish(&first.generation, Err("late failure".into())));
        assert!(launches.abandon(&first.generation, super::launch::ARTWORK_FAILED, true));
        assert_eq!(launches.error.as_deref(), Some(super::launch::ARTWORK_FAILED));
        let mut retry = launches.begin();
        assert_ne!(first.generation, retry.generation);
        assert!(launches.error.is_none());
        assert!(!launches.finish(&first.generation, Ok(())));
        assert!(launches.loading(&retry.generation));
        launches.finish(&retry.generation, Ok(()));
        assert_eq!(retry.wait().await, Ok(()));
    });
}

#[test]
fn cancellation_and_timeout_never_let_an_old_page_show_a_new_window() {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
    runtime.block_on(async {
        let mut launches = super::launch::Launches::default();
        let mut cancelled = launches.begin();
        launches.cancel();
        assert_eq!(cancelled.wait().await, Err(super::launch::CANCELLED.into()));
        let mut pending = launches.begin();
        assert!(tokio::time::timeout(std::time::Duration::from_millis(1), pending.wait())
            .await
            .is_err());
        assert!(launches.abandon(&pending.generation, super::launch::TIMED_OUT, true));
        assert_eq!(pending.wait().await, Err(super::launch::TIMED_OUT.into()));
        assert!(!launches.finish(&cancelled.generation, Ok(())));
        assert!(!launches.finish(&pending.generation, Ok(())));
        assert_eq!(launches.error.as_deref(), Some(super::launch::TIMED_OUT));
    });
}

#[test]
fn the_fixed_companion_does_not_restore_generic_window_state_or_focus() {
    assert!(!super::window_state_tracks("desktop-pet"));
    assert!(super::window_state_tracks("main"));
    assert!(super::window_state_tracks("project-1"));
}

#[test]
fn a_visible_pet_does_not_block_reopening_the_workspace_after_its_last_window_closes() {
    use super::reopen_needed;
    assert!(!reopen_needed(true, [("main", true), ("desktop-pet", true)]));
    // Closing the workspace changes Cocoa's key window, but a pet still makes
    // has_visible_windows true. The app must handle the user's next Dock open.
    assert!(reopen_needed(true, [("main", false), ("desktop-pet", true)]));
    assert!(reopen_needed(true, [("browser-1", false), ("desktop-pet", true)]));
    assert!(!reopen_needed(true, [("site-content-1", true), ("desktop-pet", true)]));
    assert!(reopen_needed(false, [("main", false)]));
}
