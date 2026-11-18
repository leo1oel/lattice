use super::keeps_running_without_windows;

#[test]
fn closing_the_last_window_leaves_lattice_running_on_a_mac() {
    // Before: only a browser-resident host stayed, so ⌘W on the last
    // window quit Lattice outright.
    assert_eq!(keeps_running_without_windows(false), cfg!(target_os = "macos"));
    assert!(keeps_running_without_windows(true));
}

/// The core reports its own `CARGO_PKG_VERSION` as Lattice's (user agents,
/// the terminal, TexLab), so scripts/bump-version.mjs moves both.
#[test]
fn the_core_carries_the_app_version() {
    assert_eq!(lattice_core::VERSION, env!("CARGO_PKG_VERSION"));
}
