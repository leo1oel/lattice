fn main() {
    println!("cargo:rerun-if-changed=src/process_inspector.c");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/process_inspector.c")
            .warnings(true)
            .compile("lattice_process_inspector");
    }
    // The bundled Firecrawl key is compile-time (option_env! in firecrawl.rs);
    // without this line cargo would keep a stale binary when the key changes.
    println!("cargo:rerun-if-env-changed=LATTICE_FIRECRAWL_KEY");
    // `LATTICE_FLAVOR=beta` builds Lattice Beta (docs/release-process.md):
    // `cfg(lattice_beta)` moves the browser port off the release app's. Any
    // other value is a typo that would silently build the release flavor.
    println!("cargo:rerun-if-env-changed=LATTICE_FLAVOR");
    println!("cargo::rustc-check-cfg=cfg(lattice_beta)");
    match std::env::var("LATTICE_FLAVOR").as_deref() {
        Err(_) | Ok("") => {}
        Ok("beta") => println!("cargo:rustc-cfg=lattice_beta"),
        Ok(other) => panic!("LATTICE_FLAVOR={other:?}: the only flavor is \"beta\""),
    }
    tauri_build::build()
}
