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
    tauri_build::build()
}
