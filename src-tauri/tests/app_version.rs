/// The core reports its own `CARGO_PKG_VERSION` as Lattice's (user agents,
/// the terminal, TexLab), so scripts/bump-version.mjs moves both.
#[test]
fn the_core_carries_the_app_version() {
    assert_eq!(lattice_core::VERSION, env!("CARGO_PKG_VERSION"));
}
